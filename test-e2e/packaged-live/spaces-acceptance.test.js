const { memberWebsite } = require('./spaces-acceptance');

test('member acceptance requires the full name and an exact usable HTTPS destination', () => {
  expect(memberWebsite('Member@Example=https://site.example/member?x=1')).toEqual({
    handle: 'member@example', url: 'https://site.example/member?x=1',
  });
});

test.each([
  undefined, '', '@example=https://site.example/', 'member@example',
  'member@example=http://site.example/', 'member@example=https://user:password@site.example/',
  'member@example=https://127.0.0.1/', 'member@example=https://localhost/',
  'a@b@c=https://site.example/',
])('member acceptance fails without a real member and safe destination: %s', (value) => {
  expect(() => memberWebsite(value)).toThrow('FREEDOM_E2E_SPACES_MEMBER_WEBSITE');
});
