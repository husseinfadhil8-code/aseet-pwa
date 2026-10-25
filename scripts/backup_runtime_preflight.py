"""Read-only TCP diagnosis. Never authenticates, exports data or prints secrets."""
import argparse
import ipaddress
import json
import os
import re
import socket
from urllib.parse import urlsplit


def valid_host(value):
    if not value or len(value) > 253:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
                   for label in value.split('.'))


def credential_status(env):
    value = env.get('WASEET_TEST_DATABASE_URL', '')
    result = {
        'database_url_present': bool(value),
        'backup_passphrase_present': bool(env.get('WASEET_BACKUP_PASSPHRASE')),
        'database_url_parseable': False,
    }
    try:
        parsed = urlsplit(value)
        result['database_url_parseable'] = bool(
            parsed.scheme in ('postgres', 'postgresql') and valid_host(parsed.hostname)
            and 0 < (parsed.port or 5432) <= 65535)
    except ValueError:
        pass
    return result


def tcp_probe(proxy, host, port=5432):
    # Only the supported TCP proxy is used; no direct-route fallback.
    if not valid_host(host) or not 0 < port <= 65535:
        return 'invalid_destination'
    try:
        parsed = urlsplit(proxy)
        if parsed.scheme != 'http' or not valid_host(parsed.hostname) or not parsed.port:
            return 'invalid_tcp_proxy'
        with socket.create_connection((parsed.hostname, parsed.port), timeout=6) as conn:
            conn.settimeout(6)
            authority = f'[{host}]:{port}' if ':' in host else f'{host}:{port}'
            conn.sendall(f'CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n'.encode('ascii'))
            header = b''
            while b'\r\n' not in header and len(header) < 4096:
                chunk = conn.recv(1)
                if not chunk:
                    break
                header += chunk
            # Never return raw proxy responses: these can contain sensitive data.
            match = re.fullmatch(rb'HTTP/1\.[01] ([0-9]{3})(?: [^\r\n]*)?\r\n', header)
            if not match:
                return 'invalid_proxy_response'
            code = int(match[1])
            return 'tcp_connected' if code == 200 else f'proxy_http_{code}'
    except (ValueError, UnicodeError):
        return 'invalid_tcp_proxy'
    except ConnectionRefusedError:
        return 'tcp_proxy_connection_refused'
    except socket.gaierror:
        return 'tcp_proxy_dns_failed'
    except TimeoutError:
        return 'tcp_proxy_timeout'
    except OSError:
        return 'tcp_proxy_os_error'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True, help='Non-secret Test pooler hostname from environment metadata')
    args = parser.parse_args()
    result = credential_status(os.environ)
    try:
        with open('/etc/codex/network-policy.json') as stream:
            policy = json.load(stream)
        if policy.get('version') != 1:
            raise ValueError()
        access = policy.get('tcp_network_access') or {}
        result['tcp_grant_list_empty'] = not (access.get('domains') or access.get('ip_ranges'))
        result['tcp_5432'] = tcp_probe(policy.get('tcp_connect_proxy', ''), args.host)
    except (OSError, ValueError, TypeError, AttributeError):
        result['tcp_5432'] = 'network_policy_unavailable'
    result['postgres_authentication_tested'] = False
    result['tls_tested'] = False
    print(json.dumps(result, sort_keys=True))
    return 0 if (result.get('tcp_5432') == 'tcp_connected'
                 and result['database_url_parseable'] and result['backup_passphrase_present']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
