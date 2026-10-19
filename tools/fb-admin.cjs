// One-off Firebase project setup using the firebase-tools login stored on this Mac.
// Usage: node tools/fb-admin.cjs <projectId> <command>
//   enable-apis  – turn on Firestore + Identity Toolkit APIs
//   auth         – enable anonymous + email/password sign-in, authorized domains
//   auth-show    – print current auth config
const path = require('path');
const lib = (p) => require(path.join(__dirname, '..', 'node_modules', 'firebase-tools', 'lib', p));
const { requireAuth } = lib('requireAuth');
const { Client } = lib('apiv2');
const { ensure } = lib('ensureApiEnabled');

const [projectId, cmd] = process.argv.slice(2);
const DOMAINS = ['localhost', `${projectId}.firebaseapp.com`, `${projectId}.web.app`, 'valorin777.github.io'];

async function main() {
  const account = lib('auth').getGlobalDefaultAccount();
  if (!account) throw new Error('run: firebase login');
  await requireAuth({ user: account.user, tokens: account.tokens });
  const it = new Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', apiVersion: 'admin/v2' });
  if (cmd === 'enable-apis') {
    for (const api of ['firestore.googleapis.com', 'identitytoolkit.googleapis.com', 'securetoken.googleapis.com']) {
      await ensure(projectId, `https://${api}`, 'setup', false);
      console.log('enabled', api);
    }
  } else if (cmd === 'auth') {
    // New projects need Firebase Auth initialized before config can be patched.
    try {
      await new Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', apiVersion: 'v2' })
        .post(`/projects/${projectId}/identityPlatform:initializeAuth`, {});
      console.log('auth initialized');
    } catch (e) { console.log('initializeAuth:', e.message.split('\n')[0]); }
    const body = {
      signIn: { anonymous: { enabled: true }, email: { enabled: true, passwordRequired: true } },
      authorizedDomains: DOMAINS,
    };
    const res = await it.patch(`/projects/${projectId}/config`, body, {
      queryParams: { updateMask: 'signIn.anonymous.enabled,signIn.email.enabled,signIn.email.passwordRequired,authorizedDomains' },
    });
    console.log(JSON.stringify({ anonymous: res.body.signIn?.anonymous, email: res.body.signIn?.email, authorizedDomains: res.body.authorizedDomains }));
  } else if (cmd === 'auth-show') {
    const res = await it.get(`/projects/${projectId}/config`);
    console.log(JSON.stringify({ anonymous: res.body.signIn?.anonymous, email: res.body.signIn?.email, authorizedDomains: res.body.authorizedDomains }));
  } else {
    throw new Error('unknown command ' + cmd);
  }
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
