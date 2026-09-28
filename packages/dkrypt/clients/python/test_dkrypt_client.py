import unittest
from email.message import Message
from unittest.mock import MagicMock, patch

from dkrypt_client import DkryptClient, DkryptRedirectHandler


class Response:
    def __enter__(self):
        return self

    def __exit__(self, error_type, error, traceback):
        return False

    def read(self):
        return b'IPA'


class DkryptClientTests(unittest.TestCase):
    @patch('dkrypt_client.build_opener')
    def test_download_returns_binary_bytes_with_api_key(self, build_opener):
        opener = MagicMock()
        opener.open.return_value = Response()
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        result = client.download('/v1/artifacts/artifact-1/file')

        request = opener.open.call_args.args[0]
        self.assertEqual(result, b'IPA')
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.unredirected_hdrs.get('Authorization'), 'Bearer dk_test_key')
        self.assertEqual(request.get_header('Accept'), 'application/octet-stream')

    @patch('dkrypt_client.build_opener')
    def test_download_only_forwards_the_api_key_to_its_configured_origin(self, build_opener):
        opener = MagicMock()
        opener.open.return_value = Response()
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        client.download('/v1/artifacts/artifact-1/file')

        request = opener.open.call_args.args[0]
        handler = build_opener.call_args.args[0]
        same_origin_redirect = handler.redirect_request(
            request,
            None,
            302,
            'Found',
            Message(),
            'https://ipa.dylib.dev/v1/artifacts/artifact-1/file',
        )
        cross_origin_redirect = handler.redirect_request(
            request,
            None,
            302,
            'Found',
            Message(),
            'https://attacker.example/collect',
        )
        self.assertEqual(same_origin_redirect.unredirected_hdrs.get('Authorization'), 'Bearer dk_test_key')
        self.assertNotIn('Authorization', dict(cross_origin_redirect.header_items()))

    @patch('dkrypt_client.build_opener')
    def test_download_keeps_at_sign_paths_on_the_configured_origin(self, build_opener):
        opener = MagicMock()
        opener.open.return_value = Response()
        build_opener.return_value = opener
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        client.download('@attacker.example/collect')

        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://ipa.dylib.dev/@attacker.example/collect')
        self.assertEqual(request.unredirected_hdrs.get('Authorization'), 'Bearer dk_test_key')

    @patch('dkrypt_client.build_opener')
    def test_download_rejects_a_path_that_changes_the_request_origin(self, build_opener):
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        with self.assertRaisesRegex(ValueError, 'configured origin'):
            client.download('https://attacker.example/collect')

        build_opener.assert_not_called()

    @patch('dkrypt_client.build_opener')
    def test_download_distinguishes_port_zero_from_the_default_https_port(self, build_opener):
        client = DkryptClient('https://ipa.dylib.dev:0', api_key='dk_test_key')

        with self.assertRaisesRegex(ValueError, 'configured origin'):
            client.download('https://ipa.dylib.dev:443/collect')

        build_opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
