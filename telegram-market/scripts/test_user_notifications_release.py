"""Release guards only; no network, database or Telegram access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timezone

SPEC = importlib.util.spec_from_file_location('release', Path(__file__).with_name('user_notifications_release.py'))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseGuards(unittest.TestCase):
    def env(self):
        return dict(GITHUB_REF=release.BRANCH, CONFIRM_TEST_REF=release.REF,
                    GITHUB_REPOSITORY=release.REPOSITORY,
                    GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_SHA='a' * 40,
                    GITHUB_RUN_ID='123')

    def test_only_reviewed_manual_owner_target_is_allowed(self):
        with patch.dict(os.environ, self.env(), clear=True):
            release.require_target()
            for field in ('GITHUB_REF', 'CONFIRM_TEST_REF', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME'):
                with patch.dict(os.environ, {field: 'incorrect'}):
                    with self.assertRaises(release.BackupError):
                        release.require_target()

    def test_backup_ciphertext_tamper_and_restore_failure_stop_release(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, self.env(), clear=True):
            path = Path(directory)
            cipher = path / 'Waseet-Test.postgres.tar.gpg'
            cipher.write_bytes(b'isolated-test-ciphertext')
            (path / 'SHA256SUMS').write_text(hashlib.sha256(cipher.read_bytes()).hexdigest() + '  ' + cipher.name + '\n')
            proof = dict(project_ref=release.REF, actual_hosted_backup=True,
                         isolated_postgres_restore_verified=True, source_tls_verified=True,
                         verified_at=datetime.now(timezone.utc).isoformat(),
                         workflow_commit='a' * 40, run_id=123)
            target = path / 'verification.json'
            target.write_text(json.dumps(proof))
            release.verified_backup(path)
            proof['isolated_postgres_restore_verified'] = False
            target.write_text(json.dumps(proof))
            with self.assertRaises(release.BackupError):
                release.verified_backup(path)
            proof['isolated_postgres_restore_verified'] = True
            target.write_text(json.dumps(proof))
            cipher.write_bytes(b'tampered')
            with self.assertRaises(release.BackupError):
                release.verified_backup(path)

    def test_apply_refuses_without_pause_before_database_connection(self):
        with patch.dict(os.environ, self.env(), clear=True), \
                patch.object(release, 'verified_backup', return_value={'run_id': 123}), \
                patch.object(release, 'connection') as connection:
            with self.assertRaises(release.BackupError):
                release.release('apply', Path('/unused'), Path('/unused'))
            connection.assert_not_called()

    def test_reviewed_sql_contains_no_top_level_commit_or_drop(self):
        texts, digests = release.sql_bundle()
        self.assertEqual(set(digests), set(release.SQL_FILES))
        self.assertEqual(len(texts), 2)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'telegram-market/db'
            folder.mkdir(parents=True)
            for name in release.SQL_FILES:
                (folder / name).write_text('COMMIT;')
            with patch.object(release, 'ROOT', root):
                with self.assertRaises(release.BackupError):
                    release.sql_bundle()


if __name__ == '__main__':
    unittest.main()
