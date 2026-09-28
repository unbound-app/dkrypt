import unittest
from unittest.mock import patch

from dkrypt_client import DkryptClient


class Response:
    def __enter__(self):
        return self

    def __exit__(self, error_type, error, traceback):
        return False

    def read(self):
        return b'IPA'


class DkryptClientTests(unittest.TestCase):
    @patch('dkrypt_client.urlopen')
    def test_download_returns_binary_bytes_with_api_key(self, urlopen):
        urlopen.return_value = Response()
        client = DkryptClient('https://ipa.dylib.dev', api_key='dk_test_key')

        result = client.download('/v1/artifacts/artifact-1/file')

        request = urlopen.call_args.args[0]
        self.assertEqual(result, b'IPA')
        self.assertEqual(request.get_method(), 'GET')
        self.assertEqual(request.get_header('Authorization'), 'Bearer dk_test_key')
        self.assertEqual(request.get_header('Accept'), 'application/octet-stream')


if __name__ == '__main__':
    unittest.main()
