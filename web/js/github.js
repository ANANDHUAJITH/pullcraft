// Opens a PullCraft pull request straight from the browser using the player's own GitHub token.
// The token is used only for requests to api.github.com and is never stored.
const API = 'https://api.github.com';
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}
const tryGh = async (...a) => { try { return await gh(...a); } catch (e) { return e.status === 404 ? null : Promise.reject(e); } };

export function uploadPageUrl(repo, branch) { return `https://github.com/${repo}/upload/${branch}/plots`; }

/**
 * @param {{token:string, upstream:string, branch:string, login?:string, doc:object, ownRepo:boolean, log:(m:string)=>void}} o
 * @returns {Promise<{url:string, login:string}>}
 */
export async function submitPlot({ token, upstream, branch, doc, ownRepo, log }) {
  const me = await gh(token, 'GET', '/user').catch((e) => { throw new Error(e.status === 401 ? 'GitHub rejected that token.' : e.message); });
  const login = me.login;
  const [upOwner, upName] = upstream.split('/');
  let fileDoc = doc;

  if (ownRepo) {
    log('Saving your build to your own repository…');
    const repoName = 'pullcraft-builds';
    if (!(await tryGh(token, 'GET', `/repos/${login}/${repoName}`))) {
      await gh(token, 'POST', '/user/repos', { name: repoName, description: 'My PullCraft builds', auto_init: true, private: false });
    }
    const existing = await tryGh(token, 'GET', `/repos/${login}/${repoName}/contents/plot.json`);
    const put = await gh(token, 'PUT', `/repos/${login}/${repoName}/contents/plot.json`, {
      message: `Update build: ${doc.title || 'Untitled'}`, content: b64(JSON.stringify(doc)), ...(existing ? { sha: existing.sha } : {}),
    });
    fileDoc = { version: 1, title: doc.title || '', description: doc.description || '', source: { repo: `${login}/${repoName}`, path: 'plot.json', sha: put.commit.sha } };
  }

  const direct = login.toLowerCase() === upOwner.toLowerCase();
  let headRepo = upstream, headRef;
  if (!direct) {
    log('Forking the world repository…');
    const fork = await gh(token, 'POST', `/repos/${upstream}/forks`, { default_branch_only: true });
    headRepo = fork.full_name;
    for (let i = 0; i < 20; i++) { if (await tryGh(token, 'GET', `/repos/${headRepo}`)) break; await sleep(1500); }
    await gh(token, 'POST', `/repos/${headRepo}/merge-upstream`, { branch }).catch(() => {});
  }
  log('Creating a branch…');
  const base = await gh(token, 'GET', `/repos/${upstream}/git/ref/heads/${branch}`);
  const name = `pullcraft/plot-${Date.now().toString(36)}`;
  await gh(token, 'POST', `/repos/${headRepo}/git/refs`, { ref: `refs/heads/${name}`, sha: base.object.sha });
  headRef = direct ? name : `${login}:${name}`;

  log('Committing your plot…');
  const path = `plots/${login}.json`;
  const current = await tryGh(token, 'GET', `/repos/${upstream}/contents/${path}?ref=${branch}`);
  await gh(token, 'PUT', `/repos/${headRepo}/contents/${path}`, {
    message: `Update plot: ${login}`, content: b64(JSON.stringify(fileDoc)), branch: name, ...(current ? { sha: current.sha } : {}),
  });

  log('Opening the pull request…');
  const pr = await gh(token, 'POST', `/repos/${upstream}/pulls`, {
    title: `Plot: ${doc.title || login}`, head: headRef, base: branch, maintainer_can_modify: false,
    body: `Build submitted from the PullCraft editor.\n\n- Blocks: ${doc.blocks?.length ?? 'linked'}\n- Stored in: ${ownRepo ? 'my own repository (pinned commit)' : 'this pull request'}`,
  });
  return { url: pr.html_url, login };
}
