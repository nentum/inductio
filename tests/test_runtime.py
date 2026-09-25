import queue
import sqlite3
import time

import pytest

from deductio.ledger import InvalidEntry, Ledger
from deductio.runtime import Engine
from conftest import (PREFIX, business_outputs, claim_for, code_frame, end_for,
                      external, function, output, request, spin)


def prepare(engine,code,name='f'):
    fn=external(engine,[function(name,code)])['entries'][0]
    return external(engine,[request(functions=f'SELECT id FROM entries WHERE id={fn}')])['entries'][0]


def finish(engine):
    external(engine,close=True)
    engine.run(until_idle=True,max_seconds=8)


def test_all_fanout_claims_exist_before_first_business_spawn(harness):
    ledger,engine=harness
    external(engine,[function(str(i),PREFIX+code_frame('output',{'worker':i})+code_frame('end',{})) for i in range(3)])
    req=external(engine,[request()])['entries'][0]
    finish(engine)
    claims=[r for r in ledger.rows('claim') if r['data']['request']==req]
    starts=[r for r in ledger.rows('event') if r['data'].get('event')=='process_started' and r['claim_id']!=engine.entry_claim]
    assert len(claims)==len(starts)==3
    assert max(r['id'] for r in claims)<min(r['id'] for r in starts)
    assert sorted(r['data']['worker'] for r in business_outputs(ledger))==[0,1,2]


def test_end_rejects_late_output_and_late_request(harness):
    ledger,engine=harness
    req=prepare(engine,PREFIX+code_frame('output',{'accepted':True})+code_frame('end',{})
                +code_frame('output',{'late':True})+code_frame('request',{
                    'functions':"SELECT id FROM entries WHERE kind='function'",'inputs':'SELECT id FROM entries WHERE 0'})
                +'time.sleep(3)\n')
    finish(engine);claim=claim_for(ledger,req)
    own=[r for r in ledger.rows() if r['claim_id']==claim and r['position'] is not None]
    assert [r['data'] for r in own]==[{'accepted':True}]
    assert end_for(ledger,claim)['data']['last_position']==1
    events=[r['data']['event'] for r in ledger.rows('event') if r['claim_id']==claim]
    assert 'late_output_rejected' in events and 'process_exited' in events
    assert len(ledger.rows('request'))==2  # startup + business request


@pytest.mark.parametrize('tail',['','sys.exit(7)\n'])
def test_exit_drains_output_without_business_verdict(harness,tail):
    ledger,engine=harness
    req=prepare(engine,PREFIX+"for i in range(70):\n print(json.dumps({'kind':'output','data':{'i':i}}),flush=True)\n"+tail)
    finish(engine);claim=claim_for(ledger,req)
    assert [r['data']['i'] for r in ledger.rows('output') if r['claim_id']==claim]==list(range(70))
    end=end_for(ledger,claim)['data']
    assert end['reason']=='process_exit' and end['last_position']==70
    assert end['evidence']['exit_code']==(7 if tail else 0)
    assert 'success' not in end


@pytest.mark.parametrize('bad',[
 "print('not json',flush=True)\n",
 "print('{\"kind\":\"claim\",\"data\":{}}',flush=True)\n",
 "print('{\"kind\":\"end\",\"data\":{\"reason\":3}}',flush=True)\n",
 "sys.stdout.write('{}');sys.stdout.flush()\n", "print('x'*1048577,flush=True)\n"])
def test_malformed_protocol_seals_instance(harness,bad):
    ledger,engine=harness
    req=prepare(engine,PREFIX+bad);finish(engine)
    assert end_for(ledger,claim_for(ledger,req))['data']['reason']=='protocol_error'


def test_stderr_drained_bounded_not_business_output(harness):
    ledger,engine=harness
    req=prepare(engine,PREFIX+"sys.stderr.write('x'*100000);sys.stderr.flush()\n"+code_frame('end',{}))
    finish(engine);claim=claim_for(ledger,req)
    diagnostic=next(r['data'] for r in ledger.rows('event') if r['claim_id']==claim and r['data']['event']=='stderr')
    assert diagnostic['bytes']==100000 and diagnostic['truncated'] and len(diagnostic['text'])==16384
    assert not [r for r in ledger.rows('output') if r['claim_id']==claim]


def test_host_stop_works_at_full_capacity_without_synthetic_claim(harness):
    ledger,engine=harness;engine.max_running=1
    req=prepare(engine,PREFIX+code_frame('output',{'ready':True})+'time.sleep(20)\n')
    spin(engine,lambda:any(r['data'].get('ready') for r in ledger.rows('output')))
    claim=claim_for(ledger,req);before=len(ledger.rows('claim'))
    receipt=engine.command({'op':'stop','claim':claim,'reason':'operator'})
    assert ledger.is_sealed(claim) and receipt['newly_sealed']
    assert len(ledger.rows('claim'))==before
    assert end_for(ledger,claim)['data']['reason']=='explicit_stop'
    spin(engine,lambda:claim not in engine.running)
    assert not ledger.is_sealed(engine.entry_claim)


def test_builtin_stop_remains_available_to_ordinary_functions(harness):
    ledger,engine=harness;engine.max_running=1
    req=prepare(engine,PREFIX+code_frame('output',{'ready':True})+'time.sleep(20)\n')
    spin(engine,lambda:any(r['data'].get('ready') for r in ledger.rows('output')))
    target=claim_for(ledger,req)
    note=external(engine,[output(target=target,reason='ordinary request')])['entries'][0]
    stop_req=external(engine,[request(f"SELECT id FROM entries WHERE id={ledger.builtin('builtin:stop')}",
                                    f'SELECT id FROM entries WHERE id={note}')])['entries'][0]
    spin(engine,lambda:ledger.is_sealed(target))
    assert end_for(ledger,claim_for(ledger,stop_req))['data']['reason']=='builtin_returned'


def test_parent_stop_preserves_child_and_previous_outputs(harness):
    ledger,engine=harness
    child=external(engine,[function('child',PREFIX+'time.sleep(.3)\n'+code_frame('output',{'child':'survived'})+code_frame('end',{}))])['entries'][0]
    req=prepare(engine,PREFIX+code_frame('output',{'parent':'retained'})+code_frame('request',{
        'functions':f'SELECT id FROM entries WHERE id={child}','inputs':'SELECT id FROM entries WHERE 0'})+'time.sleep(20)\n')
    spin(engine,lambda:len(engine.running)==3)
    parent=claim_for(ledger,req);engine.command({'op':'stop','claim':parent})
    spin(engine,lambda:any(r['data'].get('child')=='survived' for r in ledger.rows('output')))
    assert any(r['data'].get('parent')=='retained' for r in ledger.rows('output'))


def test_shutdown_seals_queued_and_active_plus_entry(harness):
    ledger,engine=harness;engine.max_running=1
    external(engine,[function(str(i),PREFIX+'time.sleep(20)\n') for i in range(3)])
    req=external(engine,[request()])['entries'][0]
    engine.tick();assert len(engine.running)==2 and len(engine.waiting)==2
    engine.shutdown('test')
    assert all(ledger.is_sealed(r['id']) for r in ledger.rows('claim'))
    assert not engine.waiting
    spin(engine,lambda:not engine.running)


def test_slow_scheduler_does_not_discard_queued_eof(harness,monkeypatch):
    import deductio.runtime as runtime
    ledger,engine=harness
    req=prepare(engine,PREFIX+"for i in range(100):\n print(json.dumps({'kind':'output','data':{'i':i}}),flush=True)\n")
    external(engine,close=True);engine.tick();claim=claim_for(ledger,req);run=engine.running[claim]
    run.process.wait(timeout=5)
    deadline=time.monotonic()+5
    while not (run.stdout_finished.is_set() and run.stderr_finished.is_set()):
        assert time.monotonic()<deadline;time.sleep(.01)
    clock=[time.monotonic()]
    with monkeypatch.context() as patch:
        patch.setattr(runtime.time,'monotonic',lambda:clock[0])
        for _ in range(10):
            engine.tick();clock[0]+=10
            if claim not in engine.running:break
    assert [r['data']['i'] for r in ledger.rows('output') if r['claim_id']==claim]==list(range(100))


def test_spawn_failure_visible(harness,monkeypatch):
    ledger,engine=harness
    req=prepare(engine,'pass');external(engine,close=True)
    def fail(*a,**kw):raise OSError('injected spawn failure')
    monkeypatch.setattr('deductio.runtime.subprocess.Popen',fail)
    engine.run(until_idle=True)
    assert end_for(ledger,claim_for(ledger,req))['data']['reason']=='spawn_failed'


def test_storage_failure_after_spawn_cleans_process(harness,monkeypatch):
    ledger,engine=harness
    prepare(engine,PREFIX+'time.sleep(20)\n');external(engine,close=True)
    original=ledger.event;children=[]
    def fail(name,*args,**kwargs):
        if name=='process_started':
            children.extend(r.process for r in engine.running.values())
            raise sqlite3.OperationalError('injected storage error')
        return original(name,*args,**kwargs)
    monkeypatch.setattr(ledger,'event',fail)
    with pytest.raises(sqlite3.OperationalError):engine.run(until_idle=True)
    assert children and all(p.poll() is not None for p in children)


def test_function_publishes_and_executes_new_function(harness):
    ledger,engine=harness
    generated=PREFIX+code_frame('output',{'generated':'ran'})+code_frame('end',{})
    req=prepare(engine,PREFIX+code_frame('function',{'name':'generated','runner':'python','code':generated})
                +code_frame('request',{'functions':"SELECT id FROM entries WHERE kind='function' AND json_extract(data,'$.name')='generated'",'inputs':'SELECT id FROM entries WHERE 0'})+code_frame('end',{}))
    finish(engine)
    new=next(r for r in ledger.rows('function') if r['data'].get('name')=='generated')
    assert new['claim_id']==claim_for(ledger,req)
    assert any(r['data'].get('generated')=='ran' for r in ledger.rows('output'))


def test_host_append_is_gone_and_bad_controls_do_not_kill_scheduler(harness):
    ledger,engine=harness
    before=len(ledger.rows('claim'))
    for command in (None,{'op':'append','entries':[output(forbidden=True)]},
                    {'op':'stop','claim':10**100},{'op':'shutdown','reason':''}):
        engine.post(('command',None,command))
    engine.tick()
    assert len([r for r in ledger.rows('event') if r['data']['event']=='command_rejected'])==4
    assert len(ledger.rows('claim'))==before
    assert not any(r['data'].get('forbidden') for r in ledger.rows('output'))


def test_entry_empty_inputs_and_exact_genesis_reference(harness):
    ledger,engine=harness
    external(engine,[function('human',"raise RuntimeError('wrong entry')")])
    startup=ledger.get(engine.entry_request)
    claim=ledger.get(engine.entry_claim)
    assert startup['position'] is None and startup['claim_id'] is None
    assert startup['data']['session']==ledger.writer
    assert claim['data']['function']==ledger.entry_function() and claim['data']['inputs']==[]


def test_shutdown_does_not_resolve_unprocessed_business_request(harness):
    ledger,engine=harness
    external(engine,[function()]);req=external(engine,[request()])['entries'][0]
    engine.shutdown('leave pending');engine.tick()
    assert not ledger._resolved(req)


def test_large_input_to_nonreading_child_does_not_block_stop(harness):
    ledger,engine=harness;engine.max_running=1
    refs=external(engine,[output(n=i) for i in range(1500)])['entries']
    fn=external(engine,[function('nonreader','import time\ntime.sleep(20)\n')])['entries'][0]
    req=external(engine,[request(f'SELECT id FROM entries WHERE id={fn}',
        f'SELECT id FROM entries WHERE id BETWEEN {refs[0]} AND {refs[-1]}')])['entries'][0]
    engine.tick();claim=claim_for(ledger,req)
    assert len(ledger.get(claim)['data']['inputs'])==1500
    engine.command({'op':'stop','claim':claim})
    spin(engine,lambda:claim not in engine.running)


def test_malformed_builtin_stop_is_recorded_error(harness):
    ledger,engine=harness
    req=external(engine,[request(f"SELECT id FROM entries WHERE id={ledger.builtin('builtin:stop')}")])['entries'][0]
    engine.tick()
    assert end_for(ledger,claim_for(ledger,req))['data']['reason']=='builtin_error'


def test_abrupt_entry_death_is_visible_and_not_auto_restarted(harness):
    ledger,engine=harness
    external(engine,[output(before_entry_death=True)])
    claim=engine.entry_claim
    child=engine.running[claim].process
    child.kill();child.wait(timeout=5)
    spin(engine,lambda:claim not in engine.running)
    assert end_for(ledger,claim)['data']['reason']=='process_exit'
    for _ in range(3):engine.tick()
    assert len([r for r in ledger.rows('request') if r['position'] is None])==1
    assert engine.shutdown_reason is None
    with pytest.raises(InvalidEntry):external(engine,[output(after_entry_death=True)])
    engine.command({'op':'shutdown'})
