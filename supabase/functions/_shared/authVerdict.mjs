// What an auth.getUser error says about the caller, for requireUser in
// _shared/auth.ts. 'refused': the auth server answered 4xx, so the token is
// bad (401). 'unreachable': no answer, a network failure or a 5xx, so the
// sign-in check itself failed (503). The extension signs a person out only on
// a refusal, so an outage never takes the session away.
export function authVerdict(error) {
  const status = error && typeof error === 'object' && typeof error.status === 'number' ? error.status : 0;
  return status >= 400 && status < 500 ? 'refused' : 'unreachable';
}
