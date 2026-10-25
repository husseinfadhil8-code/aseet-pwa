"""Transport-level complete report reads, entirely synthetic."""
from pathlib import Path
import subprocess
import unittest
class ReportTransportTests(unittest.TestCase):
    def test_complete_reports_use_stable_gets_and_reject_partial_or_stale_results(self):
        result=subprocess.run(['node','scripts/check_reports.cjs'],cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
if __name__=='__main__':unittest.main()
