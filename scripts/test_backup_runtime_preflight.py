import json
import unittest
from unittest.mock import patch, MagicMock

from backup_runtime_preflight import credential_status, tcp_probe


class BackupPreflightSafetyTests(unittest.TestCase):
    def test_secret_values_are_not_reported_even_for_malformed_urls(self):
        for url in ('secret-placeholder', 'postgresql://user:private@[bad',
                    'postgresql://user:private@example.com:bad/db',
                    'postgresql://user:private@example.com/db'):
            result = json.dumps(credential_status({
                'WASEET_TEST_DATABASE_URL': url,
                'WASEET_BACKUP_PASSPHRASE': 'private-passphrase'}))
            self.assertNotIn('private', result)
            self.assertNotIn('secret-placeholder', result)
            self.assertNotIn('example.com', result)

    @patch('backup_runtime_preflight.socket.create_connection')
    def test_header_injection_is_rejected_without_network(self, connect):
        self.assertEqual(tcp_probe('http://proxy:8088', 'host\r\nX: value'), 'invalid_destination')
        connect.assert_not_called()

    @patch('backup_runtime_preflight.socket.create_connection')
    def test_denial_does_not_disclose_response_or_try_direct_route(self, connect):
        conn = MagicMock()
        connect.return_value.__enter__.return_value = conn
        conn.recv.side_effect = [bytes([c]) for c in b'HTTP/1.1 403 private-credential\r\n']
        self.assertEqual(tcp_probe('http://proxy:8088', 'example.com'), 'proxy_http_403')
        self.assertEqual(connect.call_count, 1)
        self.assertEqual(connect.call_args.args[0], ('proxy', 8088))

    @patch('backup_runtime_preflight.socket.create_connection', side_effect=ConnectionRefusedError('private'))
    def test_proxy_refusal_is_not_database_authentication_failure(self, connect):
        self.assertEqual(tcp_probe('http://proxy:8088', 'example.com'), 'tcp_proxy_connection_refused')

    @patch('backup_runtime_preflight.socket.create_connection')
    def test_connect_success_does_not_send_database_credentials(self, connect):
        conn = MagicMock()
        connect.return_value.__enter__.return_value = conn
        conn.recv.side_effect = [bytes([c]) for c in b'HTTP/1.1 200 OK\r\n']
        self.assertEqual(tcp_probe('http://proxy:8088', 'example.com'), 'tcp_connected')
        conn.sendall.assert_called_once_with(b'CONNECT example.com:5432 HTTP/1.1\r\nHost: example.com:5432\r\n\r\n')
