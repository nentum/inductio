"""Real subprocess/loopback acceptance. No fake human invocation path."""
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import time

import pytest

from deductio.entry_client import probe, status, submit
from deductio.ledger import InvalidEntry, Ledger, inspect_ledger
from deductio.runtime import Engine
from conftest import PREFIX, code_frame, external, function, output, request

ROOT=Path(__file__).resolve().parent.parent
HIDDEN={'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}


def cli(*args,timeout=15,input=None):
    return subprocess.run([sys.executable,'-m','deductio',*map(str,args)],cwd=ROOT,input=input,
                          capture_output=True,encoding='utf-8',timeout=timeout,**HIDDEN)


def poll_rows(path,predicate,timeout=8):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        rows=inspect_ledger(path,limit=100000)
        if predicate(rows):return rows
        time.sleep(.01)
    raise AssertionError('ledger observation timed out')


class LiveCLI:
    def __init__(self,path,*args):
        self.path=path
        self.process=subprocess.Popen([sys.executable,'-m','deductio','run',str(path),*args],cwd=ROOT,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',**HIDDEN)
        self.lines=queue.Queue();self.logs=[];self.errors=[]
        self.readers=[threading.Thread(target=self._read),threading.Thread(target=lambda:self.errors.extend(self.process.stderr))]
        for reader in self.readers:reader.start()

    def _read(self):
        for line in self.process.stdout:
            self.logs.append(line);self.lines.put(json.loads(line))

    def send(self,value):
        self.process.stdin.write(json.dumps(value,ensure_ascii=False)+'\n');self.process.stdin.flush()

    def receive(self,event,timeout=8):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            value=self.lines.get(timeout=max(.01,deadline-time.monotonic()))
            if value.get('event')==event:return value
        raise AssertionError('missing event '+event)

    def ready(self):
        self.receive('interpreter_started')
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            info=probe(self.path)
            if info['state']=='reachable':return info
            assert self.process.poll() is None, ''.join(self.errors)
            time.sleep(.02)
        raise AssertionError('entry never became reachable')

    def close(self):
        if self.process.poll() is None:
            try:
                self.send({'op':'shutdown'});self.process.wait(timeout=5)
            except (OSError,ValueError,subprocess.TimeoutExpired):
                self.process.kill();self.process.wait(timeout=5)
        if not self.process.stdin.closed:self.process.stdin.close()
        for reader in self.readers:reader.join(timeout=2)
        self.process.stdout.close();self.process.stderr.close()


def test_complete_public_path_with_host_stop_and_readonly_show(tmp_path):
    path=tmp_path/'中文账本.db';assert cli('init',path).returncode==0
    assert len(inspect_ledger(path))==3
    live=LiveCLI(path)
    try:
        info=live.ready()
        assert info['claim'] and info['probe_entry']
        second=cli('run',path,'--until-idle')
        assert second.returncode==2
        assert cli('show',path).returncode==0
        source=tmp_path/'external.json'
        source.write_text(json.dumps([
            function('worker',PREFIX+code_frame('output',{'message':'来自真实入口'})+'time.sleep(30)\n'),
            request("SELECT id FROM entries WHERE kind='function' AND json_extract(data,'$.name')='worker'")
        ],ensure_ascii=False),encoding='utf-8')
        result=cli('append',path,source);assert result.returncode==0,result.stderr
        receipt=json.loads(result.stdout);assert receipt['claim']==info['claim']
        rows=poll_rows(path,lambda rows:any(r['data'].get('message')=='来自真实入口' for r in rows))
        assert all(next(r for r in rows if r['id']==ref)['claim_id']==info['claim'] for ref in receipt['entries'])
        req=receipt['entries'][1]
        claim=next(r['id'] for r in rows if r['kind']=='claim' and r['data']['request']==req)
        before=len([r for r in rows if r['kind']=='claim'])
        live.send({'op':'stop','claim':claim,'reason':'外部停止'})
        ack=live.receive('command_result');assert ack['result']['target']==claim
        rows=poll_rows(path,lambda rows:any(r['kind']=='event' and r['claim_id']==claim and r['data']['event']=='process_exited' for r in rows))
        assert len([r for r in rows if r['kind']=='claim'])==before
        assert any(r['kind']=='end' and r['claim_id']==claim and r['data']['reason']=='explicit_stop' for r in rows)
        assert not any(r['kind']=='end' and r['claim_id']==info['claim'] for r in rows)
        live.send({'op':'append','entries':[output(bypass=True)]})
        live.receive('command_error')
        assert not any(r['data'].get('bypass') for r in inspect_ledger(path))
    finally:live.close()
    assert live.process.returncode==0 and not live.errors


def test_append_without_runtime_never_creates_execution_records(tmp_path):
    path=tmp_path/'offline.db';cli('init',path)
    before=path.read_bytes()
    result=cli('append',path,'-',input=json.dumps(output(text='not accepted')))
    assert result.returncode==2 and 'run the interpreter first' in result.stderr
    assert path.read_bytes()==before
    assert len(inspect_ledger(path))==3


def test_until_idle_does_not_ignore_live_entry(tmp_path):
    path=tmp_path/'idle.db';cli('init',path)
    live=LiveCLI(path,'--until-idle')
    try:
        info=live.ready();time.sleep(.15)
        assert live.process.poll() is None
        assert cli('append',path,ROOT/'examples'/'seed.json').returncode==0
        result=cli('close-entry',path);assert result.returncode==0,result.stderr
        assert live.process.wait(timeout=8)==0
        rows=inspect_ledger(path)
        assert any(r['data'].get('echo')=='你好，deductio' for r in rows)
        assert next(r for r in rows if r['id']==json.loads(result.stdout)['sealed'])['claim_id']==info['claim']
    finally:live.close()


def test_stdin_eof_does_not_close_entry(tmp_path):
    path=tmp_path/'eof.db';cli('init',path)
    live=LiveCLI(path,'--until-idle')
    try:
        live.ready();live.process.stdin.close();time.sleep(.05)
        assert live.process.poll() is None
        assert submit(path,[output(still_receiving=True)])['entries']
        submit(path,close=True);assert live.process.wait(timeout=8)==0
    finally:live.close()


def test_entry_exit_not_restarted_until_next_run(tmp_path):
    path=tmp_path/'exit.db';cli('init',path)
    live=LiveCLI(path)
    try:
        first=live.ready();submit(path,close=True)
        time.sleep(.1);assert live.process.poll() is None
        assert probe(path)['state']=='sealed'
        with pytest.raises(InvalidEntry):submit(path,[output(x=1)])
        assert len([r for r in inspect_ledger(path) if r['kind']=='request'])==1
    finally:live.close()
    next_run=LiveCLI(path,'--until-idle')
    try:
        second=next_run.ready()
        assert first['claim']!=second['claim'] and first['session']!=second['session']
        submit(path,close=True);assert next_run.process.wait(timeout=8)==0
    finally:next_run.close()


def test_orphan_startup_not_replayed_after_actual_process_death(tmp_path):
    path=tmp_path/'interrupted.db';cli('init',path)
    code=f'''
import os
from deductio.ledger import Ledger
with Ledger({str(path)!r}) as ledger:
    ledger.event("session_started", {{"test":"crash_after_startup_before_claim"}})
    ledger.startup_request()
    os._exit(23)
'''
    crashed=subprocess.run([sys.executable,'-c',code],cwd=ROOT,capture_output=True,timeout=5,**HIDDEN)
    assert crashed.returncode==23
    old=next(r['id'] for r in inspect_ledger(path) if r['kind']=='request')
    live=LiveCLI(path,'--until-idle')
    try:
        info=live.ready();rows=inspect_ledger(path)
        assert len([r for r in rows if r['kind']=='claim'])==1
        assert not any(r['kind']=='claim' and r['data']['request']==old for r in rows)
        assert any(r['data'].get('event')=='startup_abandoned' and r['data']['request']==old for r in rows)
        assert info['request']!=old
        submit(path,close=True);live.process.wait(timeout=8)
    finally:live.close()


def test_old_backlog_cannot_take_entry_slot_and_same_name_does_not_replace_genesis(tmp_path):
    path=tmp_path/'backlog.db'
    with Ledger(path,create=True) as ledger:
        engine=Engine(ledger,max_running=1);engine.start()
        try:
            fn=external(engine,[function('human',PREFIX+code_frame('output',{'business_started':True})+'time.sleep(30)\n')])['entries'][0]
            refs=external(engine,[request(f'SELECT id FROM entries WHERE id={fn}') for _ in range(18)])['entries']
            # Only the entry transport has been pumped; all business requests
            # remain durably pending across this graceful stop.
            engine.shutdown('leave backlog')
        finally:engine.close()
    live=LiveCLI(path,'--max-running','1')
    try:
        info=live.ready()
        rows=poll_rows(path,lambda rows:any(r['data'].get('business_started') for r in rows))
        starts=[r for r in rows if r['data'].get('event')=='process_started' and r['writer']==info['session']]
        assert starts[0]['claim_id']==info['claim'] and len(starts)==2
        assert next(r for r in rows if r['id']==info['claim'])['data']['function']==2
        # Still accepts work even with the only ordinary slot occupied.
        assert submit(path,[output(accepted_during_backlog=True)])['claim']==info['claim']
        assert any(r['kind']=='claim' and r['data']['request'] in refs for r in rows)
    finally:live.close()


def test_restart_closes_old_claims_without_rerunning_side_effect(tmp_path):
    path=tmp_path/'crash.db';marker=tmp_path/'external-effect.txt';cli('init',path)
    live=LiveCLI(path)
    try:
        old=live.ready()
        code=PREFIX+f"with open({str(marker)!r},'a',encoding='utf-8') as f: f.write('once\\n');f.flush()\n"+code_frame('output',{'executed':True})+'time.sleep(.8)\n'+code_frame('output',{'late':True})
        fn=submit(path,[function('once',code)])['entries'][0]
        req=submit(path,[request(f'SELECT id FROM entries WHERE id={fn}')])['entries'][0]
        rows=poll_rows(path,lambda rows:any(r['data'].get('executed') for r in rows))
        claim=next(r['id'] for r in rows if r['kind']=='claim' and r['data']['request']==req)
        live.process.kill();live.process.wait(timeout=5)
    finally:live.close()
    restarted=LiveCLI(path,'--until-idle')
    try:
        new=restarted.ready();assert new['session']!=old['session']
        # Old endpoint must never be selected by the client after a new session.
        assert status(path)['endpoint']==new['endpoint']
        time.sleep(1)
        rows=inspect_ledger(path)
        for ref in (claim,old['claim']):
            end=next(r for r in rows if r['kind']=='end' and r['claim_id']==ref)
            assert end['data']['reason']=='recovery_unknown'
        assert len([r for r in rows if r['kind']=='claim' and r['data']['request']==req])==1
        assert marker.read_text(encoding='utf-8')=='once\n'
        assert not any(r['data'].get('late') for r in rows)
        submit(path,close=True);restarted.process.wait(timeout=8)
    finally:restarted.close()


def test_death_during_fanout_transaction_has_no_partial_claims(tmp_path):
    path=tmp_path/'atomic.db'
    with Ledger(path,create=True) as ledger:
        engine=Engine(ledger);engine.start()
        try:
            external(engine,[function('a'),function('b'),function('c')])
            req=external(engine,[request()])['entries'][0]
        finally:engine.close()
    source=f'''
import os
from deductio.ledger import Ledger
with Ledger({str(path)!r}) as ledger:
    old=ledger._append
    def crash(kind,*args,**kwargs):
        result=old(kind,*args,**kwargs)
        if kind=="claim": os._exit(23)
        return result
    ledger._append=crash
    ledger.resolve({req})
'''
    died=subprocess.run([sys.executable,'-c',source],cwd=ROOT,capture_output=True,timeout=5,**HIDDEN)
    assert died.returncode==23
    with Ledger(path) as ledger:
        assert not ledger._resolved(req)
        assert len(ledger.resolve(req))==3


def test_entry_port_binding_failure_reported_not_available(tmp_path,monkeypatch):
    path=tmp_path/'bind-failed.db'
    with socket.socket() as occupied:
        if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):occupied.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        occupied.bind(('127.0.0.1',0));occupied.listen()
        port=occupied.getsockname()[1]
        original=Path.read_text
        def seed(self,*args,**kwargs):
            text=original(self,*args,**kwargs)
            if self.name=='entry_seed.py':return text.replace('listener.bind(("127.0.0.1", 0))',f'listener.bind(("127.0.0.1", {port}))')
            return text
        with monkeypatch.context() as patch:
            patch.setattr(Path,'read_text',seed)
            with Ledger(path,create=True):pass
        live=LiveCLI(path,'--until-idle')
        try:
            event=live.receive('interpreter_started')
            assert event['entry_available']=='unconfirmed_use_entry_status'
            assert live.process.wait(timeout=8)==0
            info=probe(path);assert info['state']=='sealed' and info['reason']=='process_exit'
            rows=inspect_ledger(path)
            exit_event=next(r for r in rows if r['data'].get('event')=='process_exited')
            assert exit_event['data']['exit_code']!=0
            assert any(r['data'].get('event')=='stderr' for r in rows)
            assert len([r for r in rows if r['kind']=='request'])==1
        finally:live.close()


def test_protocol_error_in_entry_uses_same_seal_path(tmp_path,monkeypatch):
    path=tmp_path/'bad-entry.db';original=Path.read_text
    def seed(self,*args,**kwargs):
        if self.name=='entry_seed.py':return "print('invalid-json',flush=True)\n"
        return original(self,*args,**kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path,'read_text',seed)
        with Ledger(path,create=True):pass
    result=cli('run',path,'--until-idle');assert result.returncode==0,result.stderr
    info=status(path);assert info['state']=='sealed' and info['reason']=='protocol_error'


def test_demo_really_uses_entry_and_nested_execution(tmp_path):
    path=tmp_path/'demo.db';result=cli('demo',path)
    assert result.returncode==0,result.stderr
    report=json.loads(result.stdout)
    assert report['verified']=='real_external_entry_and_child_ran_while_parent_open'
    assert report['child_claim']<report['parent_received']<report['parent_end']
    assert cli('demo',path).returncode==2


def test_invalid_source_fields_rejected_in_entry_process(tmp_path):
    path=tmp_path/'forgery.db';cli('init',path);live=LiveCLI(path)
    try:
        info=live.ready()
        result=cli('append',path,'-',input=json.dumps({'kind':'output','data':{},'claim_id':123}))
        assert result.returncode==2
        rows=poll_rows(path,lambda rows:any('entry_rejected' in r['data'] for r in rows))
        rejected=next(r for r in rows if 'entry_rejected' in r['data'])
        assert rejected['claim_id']==info['claim'] and rejected['kind']=='output'
        assert len([r for r in rows if r['kind']=='claim'])==1
    finally:live.close()


def test_entry_process_failure_to_spawn_is_observable(tmp_path,monkeypatch):
    path=tmp_path/'spawn-failed.db'
    with Ledger(path,create=True) as ledger:
        engine=Engine(ledger)
        def fail(*args,**kwargs):raise OSError('cannot launch entry')
        monkeypatch.setattr('deductio.runtime.subprocess.Popen',fail)
        try:
            engine.start()
            info=status(path)
            assert info['state']=='sealed' and info['reason']=='spawn_failed'
            assert len(ledger.rows('request'))==1
            for _ in range(3):engine.tick()
            assert len(ledger.rows('request'))==1
        finally:engine.close()


def test_business_request_cannot_disguise_itself_as_host_startup(tmp_path):
    path=tmp_path/'business-role.db'
    with Ledger(path,create=True) as ledger:
        engine=Engine(ledger);engine.start()
        try:
            fn=external(engine,[function('ordinary',PREFIX+code_frame('output',{'normal_survived':True}))])['entries'][0]
            frame=request(f'SELECT id FROM entries WHERE id={fn}')
            frame['data'].update(host_role='startup',session='old-looking-but-not-authoritative')
            req=external(engine,[frame])['entries'][0]
        finally:engine.close()
    live=LiveCLI(path,'--until-idle')
    try:
        live.ready();submit(path,close=True);assert live.process.wait(timeout=8)==0
        rows=inspect_ledger(path)
        assert any(r['data'].get('normal_survived') for r in rows)
        assert not any(r['data'].get('event')=='startup_abandoned' and r['data'].get('request')==req for r in rows)
    finally:live.close()


def test_claimed_but_unstarted_business_not_replayed_on_restart(tmp_path):
    path=tmp_path/'assigned.db'
    with Ledger(path,create=True) as ledger:
        engine=Engine(ledger);engine.start()
        try:
            fn=external(engine,[function('never-started',PREFIX+code_frame('output',{'must_not_run':True}))])['entries'][0]
            req=external(engine,[request(f'SELECT id FROM entries WHERE id={fn}')])['entries'][0]
            claims=ledger.resolve(req)  # Inject the durable crash boundary before dispatch.
        finally:engine.close()
    live=LiveCLI(path,'--until-idle')
    try:
        live.ready();submit(path,close=True);assert live.process.wait(timeout=8)==0
        rows=inspect_ledger(path)
        assert not any(r['data'].get('must_not_run') for r in rows)
        assert next(r for r in rows if r['kind']=='end' and r['claim_id']==claims[0])['data']['reason']=='recovery_unknown'
        assert len([r for r in rows if r['kind']=='claim' and r['data']['request']==req])==1
    finally:live.close()


def test_malformed_live_host_json_does_not_break_entry(tmp_path):
    path=tmp_path/'controls.db';cli('init',path);live=LiveCLI(path)
    try:
        live.ready();live.process.stdin.write('not-json\n');live.process.stdin.flush()
        live.receive('command_error')
        assert submit(path,[output(after_bad_control=True)])['entries']
    finally:live.close()


def test_bad_raw_network_json_rejected_by_entry_not_interpreter(tmp_path):
    from deductio.entry_client import connect,read_line
    path=tmp_path/'bad-wire.db';cli('init',path);live=LiveCLI(path)
    try:
        info=live.ready();client,_=connect(path)
        with client:
            client.sendall(b'not-json\n');assert 'error' in read_line(client)
        rows=inspect_ledger(path)
        error=next(r for r in rows if 'entry_rejected' in r['data'])
        assert error['claim_id']==info['claim']
        assert not any(r['data'].get('event')=='command_rejected' for r in rows)
        assert submit(path,[output(after_bad_wire=True)])['entries']
    finally:live.close()


def test_announced_endpoint_without_live_receiver_is_not_reported_ready(tmp_path):
    path=tmp_path/'unreachable.db'
    with Ledger(path,create=True) as ledger:
        engine=Engine(ledger);engine.start()
        try:
            external(engine,[output(established=True)])
            # Kill the real socket owner but deliberately do not process its
            # exit yet. The durable announcement alone is NOT availability.
            child=engine.running[engine.entry_claim].process
            child.kill();child.wait(timeout=5)
            assert status(path)['state']=='announced'
            assert probe(path)['state']=='unreachable'
        finally:engine.close()
