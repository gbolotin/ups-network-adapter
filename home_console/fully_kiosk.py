"""Local Fully REST helper. Credentials stay in an operator-owned private file."""
import json
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit, unquote
from urllib.request import ProxyHandler, build_opener


class FullyKiosk:
    def __init__(self, credentials_file):
        credentials = json.loads(Path(credentials_file).read_text(encoding='utf-8-sig'))
        self.base = f"http://{credentials['host']}:{credentials.get('port', 2323)}/"
        self.password = credentials['password']
        self.opener = build_opener(ProxyHandler({}))

    def request(self, command, **parameters):
        query = urlencode({'cmd': command, 'type': 'json', 'password': self.password, **parameters})
        with self.opener.open(self.base + '?' + query, timeout=20) as response:
            if command == 'getScreenshot':
                return response.read()
            value = json.load(response)
        if isinstance(value, dict) and value.get('status') == 'Error':
            raise RuntimeError(f'Fully command failed: {command}')
        return value

    def configure(self, settings):
        before = self.request('listSettings')
        for key, value in settings.items():
            if key not in before:
                raise ValueError(f'Unknown Fully setting: {key}')
            command = 'setBooleanSetting' if isinstance(value, bool) else 'setStringSetting'
            try:
                self.request(command, key=key, value=str(value).lower() if isinstance(value, bool) else value)
            except RuntimeError as error:
                raise RuntimeError(f'Fully setting failed: {key}') from error
        after = self.request('listSettings')
        for key, value in settings.items():
            actual = after[key]
            if str(actual).lower() != str(value).lower():
                raise RuntimeError(f'Fully setting readback failed: {key}')
        return after

    def evaluate(self, expression):
        """Return diagnostic JS data through a temporary same-page URL fragment."""
        original = self.request('deviceInfo')['currentPage']
        code = "(() => {const result=(" + expression + ");history.replaceState(history.state,'',location.pathname+location.search+'#fully-check='+encodeURIComponent(JSON.stringify(result)));})()"
        try:
            self.request('injectJavascript', code=code)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                fragment = urlsplit(self.request('deviceInfo')['currentPage']).fragment
                if fragment.startswith('fully-check='):
                    return json.loads(unquote(fragment[len('fully-check='):]))
                time.sleep(.2)
            raise RuntimeError('Tablet page did not return diagnostic data')
        finally:
            self.request('injectJavascript', code=f"history.replaceState(history.state,'',{json.dumps(original)})")
