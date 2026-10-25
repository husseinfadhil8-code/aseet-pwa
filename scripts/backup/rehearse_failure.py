"""Deliberately corrupt a restored synthetic fixture; must fail without an artifact."""
import contextlib,io,pathlib,sys,tempfile
import manual_test_backup as b
original=b.inventory
calls=0
def corrupt_target(conn):
 global calls
 calls+=1
 if calls==2:
  import psycopg2
  dsn=conn.get_dsn_parameters()
  assert dsn['host'].endswith('restore-socket') and dsn['host'].startswith('/tmp/waseet-backup-')
  writer=psycopg2.connect(**dsn)
  with writer:
   with writer.cursor() as c:c.execute("UPDATE auth.users SET value='INTENTIONALLY CORRUPTED SYNTHETIC FIXTURE'")
  writer.close()
 return original(conn)
b.inventory=corrupt_target
with tempfile.TemporaryDirectory() as tmp:
 output=pathlib.Path(tmp)/'artifact'
 sys.argv=['rehearsal','rehearsal','--output',str(output)]
 with contextlib.redirect_stderr(io.StringIO()) as error:
  code=b.main()
 assert code==1 and calls==2 and not output.exists()
 assert 'Restored rows' in error.getvalue()
 print('SYNTHETIC ONLY: changed restored row rejected; no artifact remained')
