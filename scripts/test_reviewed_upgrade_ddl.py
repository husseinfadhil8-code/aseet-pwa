from pathlib import Path
import unittest
from review.test_upgrade_rollback import validate_ddl,BUNDLE,BackupError
class ReviewedDDLTests(unittest.TestCase):
    def test_user_data_writes_and_transaction_control_are_rejected(self):
        for sql in ['COMMIT;','ROLLBACK;','INSERT INTO users VALUES (1);','DELETE FROM users;','UPDATE users SET role=1;','DO $$BEGIN COMMIT; END$$;','ALTER SYSTEM SET work_mem=1;','CALL unsafe();']:
            with self.subTest(sql=sql),self.assertRaises(BackupError):validate_ddl(sql)
    def test_original_reviewed_proposals_are_transactional_ddl_only(self):
        for path in BUNDLE.glob('*.sql'):validate_ddl(path.read_text())
