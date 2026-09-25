import json
import sqlite3

import pytest

from deductio.ledger import InvalidEntry, Ledger, Sealed, inspect_ledger, parse_json
from deductio.locking import WriterBusy
from conftest import external, function, output, request


def test_genesis_contains_real_entry_no_initial_request(tmp_path):
    with Ledger(tmp_path/'new.db',create=True) as ledger:
        rows=ledger.rows()
        assert len(rows)==3 and not ledger.rows('request')
        entry=ledger.get(ledger.entry_function())
        assert entry['data']['runner']=='python' and 'listener.bind' in entry['data']['code']
        assert all(r['data'].get('runner')!='builtin:human' for r in rows)
        assert not hasattr(ledger,'human')


def test_external_content_belongs_to_existing_executing_entry(harness):
    ledger,engine=harness
    claims_before=len(ledger.rows('claim'))
    result=external(engine,[function(),request(),output(text='hello')])
    rows=[ledger.get(ref) for ref in result['entries']]
    assert result['claim']==engine.entry_claim
    assert len(ledger.rows('claim'))==claims_before
    assert all(r['claim_id']==engine.entry_claim for r in rows)
    assert [r['position'] for r in rows]==[2,3,4]
    assert not ledger.is_sealed(engine.entry_claim)


def test_invalid_submission_rejected_by_child_before_any_output(harness):
    ledger,engine=harness
    with pytest.raises(InvalidEntry):
        external(engine,[output(should_not_exist=True),{'kind':'claim','data':{}}])
    assert not any(r['data'].get('should_not_exist') for r in ledger.rows('output'))
    rejection=next(r for r in ledger.rows('output') if 'entry_rejected' in r['data'])
    assert rejection['claim_id']==engine.entry_claim


def test_cannot_forge_source(harness):
    ledger,engine=harness
    with pytest.raises(InvalidEntry,match='source fields'):
        external(engine,[{'kind':'output','data':{},'claim_id':777}])
    assert not any(r['claim_id']==777 for r in ledger.rows())


def test_append_only_and_sealed_output_guard(harness):
    ledger,engine=harness
    result=external(engine,[output(text='original')])
    external(engine,close=True)
    with pytest.raises(sqlite3.IntegrityError,match='UPDATE forbidden'):
        ledger.conn.execute("UPDATE entries SET data='{}' WHERE id=?",(result['entries'][0],))
    with pytest.raises(sqlite3.IntegrityError,match='DELETE forbidden'):
        ledger.conn.execute('DELETE FROM entries WHERE id=?',(result['entries'][0],))
    with pytest.raises(Sealed):ledger.accept_output(engine.entry_claim,output(late=True))
    with pytest.raises(sqlite3.IntegrityError,match='instance sealed'):
        ledger._append('output',{},engine.entry_claim,99)
    with pytest.raises(sqlite3.IntegrityError):ledger._append('end',{},engine.entry_claim)
    with pytest.raises(sqlite3.IntegrityError,match='DELETE forbidden'):
        ledger.conn.execute('INSERT OR REPLACE INTO entries SELECT * FROM entries WHERE id=1')


def test_fanout_fixed_before_any_spawn(harness):
    ledger,engine=harness
    refs=external(engine,[function('a'),function('b'),function('c'),output(tag='input')])['entries']
    req=external(engine,[request(inputs="SELECT id FROM entries WHERE json_extract(data,'$.tag')='input'")])['entries'][0]
    claims=ledger.resolve(req)
    assert len(claims)==3
    records=[ledger.get(ref) for ref in claims]
    assert [r['data']['function'] for r in records]==refs[:3]
    assert all(r['data']['inputs']==[refs[3]] for r in records)
    assert len({r['data']['snapshot'] for r in records})==1
    external(engine,[function('d'),output(tag='input')])
    assert ledger.resolve(req)==[]
    assert ledger.get(records[0]['data']['resolution'])['data']['functions']==refs[:3]


def test_transaction_failure_rolls_back_full_fanout(harness,monkeypatch):
    ledger,engine=harness
    external(engine,[function('a'),function('b'),function('c')])
    req=external(engine,[request()])['entries'][0]
    before=ledger.rows();original=ledger._append;count=0
    def fail(kind,*args,**kwargs):
        nonlocal count
        if kind=='claim':
            count+=1
            if count==2:raise RuntimeError('injected')
        return original(kind,*args,**kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(ledger,'_append',fail)
        with pytest.raises(RuntimeError):ledger.resolve(req)
    assert ledger.rows()==before
    assert len(ledger.resolve(req))==3


def test_query_set_intersection(harness):
    ledger,engine=harness
    refs=external(engine,[function(),output(tag='x')])['entries']
    req=external(engine,[request(
        f'SELECT {refs[0]} AS id UNION ALL SELECT {refs[0]} UNION ALL SELECT {refs[1]} UNION ALL SELECT 99999',
        f'SELECT {refs[1]} AS id UNION ALL SELECT {refs[0]} UNION ALL SELECT 1')])['entries'][0]
    claims=ledger.resolve(req)
    assert len(claims)==1 and ledger.get(claims[0])['data']['inputs']==refs


@pytest.mark.parametrize('sql',[
 'DELETE FROM entries RETURNING id',"UPDATE entries SET data='{}' RETURNING id",'DROP TABLE entries',
 "ATTACH DATABASE ':memory:' AS evil",'PRAGMA user_version',"SELECT load_extension('x') AS id",
 'SELECT name AS id FROM sqlite_master','SELECT id FROM entries; DELETE FROM entries',
 "SELECT 'bad' AS id",'SELECT id,kind FROM entries','SELECT id AS wrong FROM entries',
 'WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x) SELECT max(n) AS id FROM x'])
def test_bad_sql_is_consumed_once(harness,sql):
    ledger,engine=harness
    req=external(engine,[request(functions=sql)])['entries'][0]
    assert ledger.resolve(req)==[]
    event=next(r for r in ledger.rows('event') if r['data'].get('request')==req)
    assert event['data']['error']
    assert ledger.resolve(req)==[]
    external(engine,[output(still_alive=True)])


def test_zero_matches_not_subscription(harness):
    ledger,engine=harness
    req=external(engine,[request()])['entries'][0]
    assert ledger.resolve(req)==[]
    external(engine,[function()])
    assert ledger.resolve(req)==[] and not ledger.pending_requests()


def test_second_writer_refused_readonly_allowed(harness):
    ledger,_=harness
    assert inspect_ledger(ledger.path)[0]['data']['schema']==2
    with pytest.raises(WriterBusy):Ledger(ledger.path)


@pytest.mark.parametrize('text',['{"a":1,"a":2}','{"a":NaN}','{"a":Infinity}'])
def test_ambiguous_json_rejected(text):
    with pytest.raises(InvalidEntry):parse_json(text)


def test_repeated_seal_keeps_first_reason(harness):
    ledger,engine=harness
    result=external(engine,close=True)
    ref,fresh=ledger.seal(engine.entry_claim,reason='different')
    assert not fresh and ref==result['sealed']
    assert ledger.get(ref)['data']['reason']=='function_end'


def test_old_schema_not_opened_writable(tmp_path):
    path=tmp_path/'old.db'
    with sqlite3.connect(path) as con:
        con.execute('CREATE TABLE old_content(text)');con.execute("INSERT INTO old_content VALUES('keep')")
        con.execute('PRAGMA user_version=1')
    before=path.read_bytes()
    with pytest.raises(InvalidEntry,match='read-only'):Ledger(path,create=True)
    assert path.read_bytes()==before and not path.with_name(path.name+'.lock').exists()
