import os,unittest
from unittest.mock import patch
from review import test_security_metadata as audit
class TestReviewGuard(unittest.TestCase):
    def test_nonmanual_or_wrong_repository_cannot_contact_any_database(self):
        for variables in ({},{'GITHUB_EVENT_NAME':'push'},{'GITHUB_REPOSITORY':'private-wrong-repository'}):
            with patch.dict(os.environ,variables,clear=True),patch.object(audit,'connection') as connection:
                with self.assertRaises(audit.BackupError) as error:audit.require_manual_test(audit.TEST_REF)
                connection.assert_not_called();self.assertNotIn('private-wrong',str(error.exception))
