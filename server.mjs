import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repositoryArgumentIndex = process.argv.indexOf('--repo');
const repositoryArgument = repositoryArgumentIndex >= 0 ? process.argv[repositoryArgumentIndex + 1] : '';
if (repositoryArgumentIndex >= 0 && !repositoryArgument) {
  throw new Error('--repo requires a path to a local DiophantineClassifier checkout.');
}
const repositoryRoot = resolve(repositoryArgument || process.env.REVIEW_REPOSITORY_ROOT || resolve(root, '..'));
const familyDirectory = resolve(repositoryRoot, 'diophantine_classifier', 'data', 'families');
const bibliographyPath = resolve(repositoryRoot, 'diophantine_classifier', 'data', 'references.bib');
const port = Number(process.env.REVIEW_WORKBENCH_PORT || 4173);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8'
};

const sourceSpecs = [
  { label: 'Matcher', path: 'diophantine_classifier/matchers.py', kind: 'implementation' },
  { label: 'Solver', path: 'diophantine_classifier/solvers.py', kind: 'implementation' },
  { label: 'Classification tests', path: 'tests/test_classify.py', kind: 'test' },
  { label: 'Solver tests', path: 'tests/test_solvers.py', kind: 'test' },
  { label: 'Family documentation', path: 'docs/FAMILIES.md', kind: 'documentation' },
  { label: 'Bibliography', path: 'diophantine_classifier/data/references.bib', kind: 'reference' }
];

const developmentDocuments = [
  { label: 'Project README', path: 'README.md' },
  { label: 'Claude guidance', path: 'CLAUDE.md' },
  { label: 'Architecture and design', path: 'docs/DESIGN.md' },
  { label: 'Family catalogue', path: 'docs/FAMILIES.md' },
  { label: 'Contributing guide', path: 'CONTRIBUTING.md' },
  { label: 'Pull request template', path: '.github/pull_request_template.md' }
];

function runProcess(command, args, { cwd = repositoryRoot, timeoutMs = 30000 } = {}) {
  return new Promise(resolveResult => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const child = spawn(command, args, { cwd, windowsHide: true });
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ...result, stdout, stderr, durationMs: Date.now() - startedAt });
    };
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, exitCode: null, timedOut: true, error: `Execution exceeded ${timeoutMs / 1000} seconds.` });
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 1_000_000) stderr += chunk.toString();
    });
    child.once('error', error => finish({ ok: false, exitCode: null, error: error.message }));
    child.once('close', exitCode => finish({ ok: exitCode === 0, exitCode }));
  });
}

function runGit(args) {
  const safeDirectory = repositoryRoot.replaceAll('\\', '/');
  return runProcess('git', ['-c', `safe.directory=${safeDirectory}`, '-c', 'core.quotepath=false', ...args], { timeoutMs: 8000 });
}

function gitWebUrl(remoteUrl = '') {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return '';
}

async function buildDevelopmentContext() {
  const [branchResult, headResult, statusResult, trackingResult, syncResult, canonicalRemoteResult, ...documentResults] = await Promise.all([
    runGit(['branch', '--show-current']),
    runGit(['log', '-1', '--format=%h%x00%s%x00%cI']),
    runGit(['status', '--short', '--untracked-files=no']),
    runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    runGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
    runGit(['remote', 'get-url', 'upstream']),
    ...developmentDocuments.map(document => readFile(resolve(repositoryRoot, document.path), 'utf8')
      .then(() => true)
      .catch(() => false))
  ]);

  if (!branchResult.ok || !headResult.ok || !statusResult.ok) {
    throw new Error('The current repository state could not be read with Git.');
  }

  const [shortHash = '', subject = '', committedAt = ''] = headResult.stdout.trim().split('\0');
  const allChanges = statusResult.stdout.split(/\r?\n/).filter(Boolean).map(line => ({
    status: line.slice(0, 2),
    path: line.slice(3)
  }));
  const changes = allChanges.slice(0, 200);
  const canonicalRepositoryUrl = gitWebUrl(
    process.env.REVIEW_REPOSITORY_URL || (canonicalRemoteResult.ok ? canonicalRemoteResult.stdout : '')
  );
  const [aheadText, behindText] = syncResult.ok ? syncResult.stdout.trim().split(/\s+/) : [];

  return {
    readOnly: true,
    repository: canonicalRepositoryUrl.split('/').at(-1) || 'DiophantineClassifier',
    branch: branchResult.stdout.trim() || '(detached HEAD)',
    head: { shortHash, subject, committedAt },
    tracking: trackingResult.ok,
    sync: syncResult.ok ? { behind: Number(behindText), ahead: Number(aheadText) } : null,
    workingTree: { clean: allChanges.length === 0, changes, total: allChanges.length, truncated: allChanges.length > changes.length },
    links: canonicalRepositoryUrl ? {
      repository: canonicalRepositoryUrl,
      pullRequests: `${canonicalRepositoryUrl}/pulls`,
      issues: `${canonicalRepositoryUrl}/issues`
    } : {},
    documents: developmentDocuments.filter((document, index) => documentResults[index]),
    verificationCommands: [
      'make test',
      'make doctest',
      'make coverage',
      'make references',
      'make smoke'
    ]
  };
}

async function detectSage() {
  const candidates = [];
  if (process.env.SAGE_EXECUTABLE) {
    candidates.push({ command: process.env.SAGE_EXECUTABLE, prefixArgs: [], label: process.env.SAGE_EXECUTABLE });
  }
  candidates.push({ command: 'sage', prefixArgs: [], label: 'sage on PATH' });
  for (const candidate of candidates) {
    const result = await runProcess(candidate.command, [...candidate.prefixArgs, '--version'], { timeoutMs: 8000 });
    if (result.ok) return { available: true, ...candidate, version: result.stdout.trim() || result.stderr.trim() };
  }
  if (process.platform === 'win32') {
    if (process.env.WSL_SAGE_EXECUTABLE) {
      const sagePath = process.env.WSL_SAGE_EXECUTABLE;
      const version = await runProcess('wsl.exe', ['-e', sagePath, '--version'], { timeoutMs: 8000 });
      if (version.ok) {
        return {
          available: true,
          command: 'wsl.exe',
          prefixArgs: ['-e', sagePath],
          label: 'WSL Conda environment: sage',
          version: version.stdout.trim() || version.stderr.trim()
        };
      }
    }
    const locate = await runProcess(
      'wsl.exe',
      ['-e', 'bash', '-ic', 'conda activate sage; command -v sage'],
      { timeoutMs: 12_000 }
    );
    const sagePath = locate.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('/'));
    if (locate.ok && sagePath) {
      const version = await runProcess('wsl.exe', ['-e', sagePath, '--version'], { timeoutMs: 8000 });
      if (version.ok) {
        return {
          available: true,
          command: 'wsl.exe',
          prefixArgs: ['-e', sagePath],
          label: 'WSL Conda environment: sage',
          version: version.stdout.trim() || version.stderr.trim()
        };
      }
    }
  } else {
    const locate = await runProcess(
      'bash',
      ['-ic', 'conda activate sage >/dev/null 2>&1; command -v sage'],
      { timeoutMs: 12_000 }
    );
    const sagePath = locate.stdout.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('/'));
    if (locate.ok && sagePath) {
      const version = await runProcess(sagePath, ['--version'], { timeoutMs: 8000 });
      if (version.ok) {
        return {
          available: true,
          command: sagePath,
          prefixArgs: [],
          label: 'Conda environment: sage',
          version: version.stdout.trim() || version.stderr.trim()
        };
      }
    }
  }
  return {
    available: false,
    message: process.platform === 'win32'
      ? 'No Sage executable was found. Verify the WSL Conda environment named sage, or set WSL_SAGE_EXECUTABLE.'
      : 'No Sage executable was found. Activate the Conda environment named sage, or set SAGE_EXECUTABLE.'
  };
}

let sageDetectionPromise;
async function sageStatus() {
  sageDetectionPromise ??= detectSage();
  const status = await sageDetectionPromise;
  if (!status.available) sageDetectionPromise = undefined;
  return status;
}

function readJsonBody(request, limit = 16_384) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > limit) reject(new Error('Request body is too large.'));
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

async function executeSage(code) {
  const detected = await sageStatus();
  if (!detected.available) return { ok: false, unavailable: true, error: detected.message };
  const encoded = Buffer.from(code, 'utf8').toString('base64');
  const runner = [
    'import ast, base64',
    'from sage.all import *',
    'from sage.repl.preparse import preparse',
    'from diophantine_classifier import SolverUnavailable, classify, solve',
    `source = preparse(base64.b64decode("${encoded}").decode("utf-8"))`,
    'tree = ast.parse(source, mode="exec")',
    'try:',
    '    if tree.body and isinstance(tree.body[-1], ast.Expr):',
    '        prefix = ast.Module(body=tree.body[:-1], type_ignores=[])',
    '        if prefix.body: exec(compile(prefix, "<review-workbench>", "exec"), globals())',
    '        result = eval(compile(ast.Expression(tree.body[-1].value), "<review-workbench>", "eval"), globals())',
    '        if result is not None: print(repr(result))',
    '    else:',
    '        exec(compile(tree, "<review-workbench>", "exec"), globals())',
    'except SolverUnavailable as error:',
    '    payload = base64.b64encode(str(error).encode("utf-8")).decode("ascii")',
    '    print("__REVIEW_WORKBENCH_UNSUPPORTED__" + payload)'
  ].join('\n');
  const result = await runProcess(
    detected.command,
    [...detected.prefixArgs, '-python', '-c', runner],
    { timeoutMs: 45_000 }
  );
  const marker = '__REVIEW_WORKBENCH_UNSUPPORTED__';
  const outputLines = result.stdout.split(/\r?\n/);
  const markerLine = outputLines.find(line => line.startsWith(marker));
  if (!markerLine) return result;
  let unsupportedMessage = 'The equation was classified, but this family has no automatic solver yet.';
  try {
    unsupportedMessage = Buffer.from(markerLine.slice(marker.length), 'base64').toString('utf8');
  } catch {
    // Keep the stable fallback message if the child output is incomplete.
  }
  return {
    ...result,
    ok: false,
    unsupported: true,
    unsupportedMessage,
    stdout: outputLines.filter(line => line !== markerLine).join('\n').trim()
  };
}

function unquote(value = '') {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function topValue(text, key, fallback = '') {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? unquote(match[1]) : fallback;
}

function sectionLines(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line === `${key}:` || line.startsWith(`${key}: `));
  if (start < 0) return [];
  const result = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[a-z][a-z0-9_-]*:/i.test(line)) break;
    result.push(line);
  }
  return result;
}

function stringList(text, key) {
  return sectionLines(text, key)
    .map(line => line.match(/^-\s+(.+)$/)?.[1])
    .filter(Boolean)
    .map(unquote);
}

function familyReferences(text) {
  const references = [];
  let current;
  for (const line of sectionLines(text, 'references')) {
    const key = line.match(/^-\s+key:\s*(.+)$/)?.[1];
    if (key) {
      current = { key: unquote(key), why: '' };
      references.push(current);
      continue;
    }
    const why = line.match(/^\s+why:\s*(.+)$/)?.[1];
    if (why && current) {
      current.why = unquote(why);
    } else if (current && line.trim()) {
      current.why = `${current.why} ${line.trim()}`.trim();
    }
  }
  return references;
}

function parseBibtex(text) {
  const entries = new Map();
  const starts = [...text.matchAll(/^@(\w+)\{([^,]+),/gm)];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index];
    const block = text.slice(match.index, starts[index + 1]?.index ?? text.length);
    const fields = {};
    for (const field of ['title', 'author', 'year', 'journal', 'booktitle', 'doi', 'url', 'eprint']) {
      const value = block.match(new RegExp(`^\\s*${field}\\s*=\\s*\\{([\\s\\S]*?)\\},?\\s*$`, 'mi'))?.[1];
      if (value) fields[field] = value.replace(/\s+/g, ' ').trim();
    }
    entries.set(match[2].trim(), { key: match[2].trim(), type: match[1], ...fields });
  }
  return entries;
}

function cleanBibTitle(title = '') {
  return title.replace(/[{}]/g, '').replace(/\\([&%#_])/g, '$1');
}

function findHitLines(content, needles) {
  if (!needles.length) return [];
  const lowerNeedles = needles.map(needle => needle.toLowerCase());
  const hits = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const lowerLine = line.toLowerCase();
    if (lowerNeedles.some(needle => lowerLine.includes(needle))) hits.push(index + 1);
  });
  return hits.slice(0, 80);
}

function referenceSource(reference, bibEntry) {
  const title = cleanBibTitle(bibEntry?.title) || reference.key;
  const arxivId = bibEntry?.eprint || bibEntry?.url?.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+)/i)?.[1];
  const url = bibEntry?.url || (bibEntry?.doi ? `https://doi.org/${bibEntry.doi}` : '');
  const pdfUrl = arxivId
    ? `https://arxiv.org/pdf/${arxivId}`
    : (/\.pdf(?:$|[?#])/i.test(url) ? url : '');
  return {
    kind: arxivId ? 'arXiv' : (bibEntry?.doi ? 'DOI' : 'Reference'),
    title,
    meta: [bibEntry?.author, bibEntry?.year, bibEntry?.journal || bibEntry?.booktitle].filter(Boolean).join(' · '),
    why: `Registry why: ${reference.why}`,
    url,
    pdfId: pdfUrl ? reference.key : '',
    pdfUrl
  };
}

async function buildCatalog() {
  const [names, bibliography, ...sourceContents] = await Promise.all([
    readdir(familyDirectory),
    readFile(bibliographyPath, 'utf8'),
    ...sourceSpecs.map(spec => readFile(resolve(repositoryRoot, spec.path), 'utf8'))
  ]);
  const bibEntries = parseBibtex(bibliography);
  const pdfSources = new Map();
  const families = [];

  for (const filename of names.filter(name => name.endsWith('.yaml')).sort()) {
    const yaml = await readFile(resolve(familyDirectory, filename), 'utf8');
    const slug = topValue(yaml, 'slug', filename.slice(0, -5));
    const name = topValue(yaml, 'name', slug);
    const references = familyReferences(yaml);
    const sources = references.map(reference => referenceSource(reference, bibEntries.get(reference.key)));
    sources.forEach(source => { if (source.pdfId) pdfSources.set(source.pdfId, source.pdfUrl); });
    sources.push({
      kind: 'Wiki',
      title: `${name} on Wikipedia`,
      meta: 'Automatically matched orientation source',
      why: 'Use for terminology and orientation; verify mathematical claims against the primary references.',
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, '_'))}`,
      wikiTitle: name.replace(/\s+/g, '_')
    });

    const referenceKeys = references.map(reference => reference.key);
    const files = [{
      label: filename,
      path: `diophantine_classifier/data/families/${filename}`,
      kind: 'registry',
      hits: [1]
    }];
    sourceSpecs.forEach((spec, index) => {
      const snakeSlug = slug.replaceAll('-', '_');
      let needles = [`"${slug}"`, `'${slug}'`];
      if (spec.kind === 'reference') needles = referenceKeys;
      if (spec.kind === 'documentation') needles = [name, slug];
      if (spec.path.endsWith('matchers.py')) needles.push(`_match_${snakeSlug}`);
      if (spec.path.endsWith('solvers.py')) {
        needles.push(`_solve_${snakeSlug}`);
        const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const dispatchFunction = sourceContents[index].match(new RegExp(`["']${escapedSlug}["']\\s*:\\s*([a-z_][a-z0-9_]*)`, 'i'))?.[1];
        if (dispatchFunction) needles.push(`def ${dispatchFunction}`);
      }
      if (spec.kind === 'test') needles.push(`test_${snakeSlug}`);
      const hits = findHitLines(sourceContents[index], needles);
      if (hits.length) files.push({ ...spec, hits });
    });

    const matcher = topValue(yaml, 'matcher', 'false') === 'true';
    const examples = stringList(yaml, 'examples');
    families.push({
      slug,
      name,
      status: topValue(yaml, 'status', 'unknown'),
      className: topValue(yaml, 'class', ''),
      form: topValue(yaml, 'form', ''),
      priority: topValue(yaml, 'priority', ''),
      matcher,
      parents: stringList(yaml, 'parents'),
      methods: stringList(yaml, 'methods'),
      examples,
      example: examples[0] || '',
      sources,
      files
    });
  }
  return { families, pdfSources };
}

function allowedRepositoryPath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (/^diophantine_classifier\/data\/families\/[a-z0-9-]+\.yaml$/.test(normalized)) return true;
  return sourceSpecs.some(spec => spec.path === normalized)
    || developmentDocuments.some(document => document.path === normalized);
}

async function serveRepositoryFile(relativePath, response) {
  if (!allowedRepositoryPath(relativePath)) {
    response.writeHead(403).end('File is outside the review allowlist');
    return;
  }
  const target = resolve(repositoryRoot, relativePath);
  if (!target.startsWith(repositoryRoot + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const content = await readFile(target, 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(404).end('File not found');
  }
}

async function servePdf(sourceId, response) {
  const { pdfSources } = await buildCatalog();
  const sourceUrl = pdfSources.get(sourceId);
  if (!sourceUrl) {
    response.writeHead(404).end('Unknown PDF source');
    return;
  }
  try {
    const upstream = await fetch(sourceUrl, {
      headers: { 'User-Agent': 'DiophantineReviewWorkbench/0.1' },
      redirect: 'follow'
    });
    if (!upstream.ok) throw new Error(`Upstream returned ${upstream.status}`);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${sourceId}.pdf"`,
      'Content-Length': bytes.length,
      'Cache-Control': 'private, max-age=3600'
    });
    response.end(bytes);
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`PDF preview unavailable: ${error.message}`);
  }
}

createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const { pathname, searchParams } = requestUrl;
  if (pathname === '/api/sage/status') {
    const status = await sageStatus();
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({
      available: status.available,
      label: status.label,
      version: status.version,
      message: status.message
    }));
    return;
  }
  if (pathname === '/api/sage/execute') {
    if (request.method !== 'POST' || request.headers['x-review-workbench'] !== '1') {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'Sage execution is restricted to the local workbench.' }));
      return;
    }
    const expectedOrigin = `http://${request.headers.host}`;
    if (request.headers.origin && request.headers.origin !== expectedOrigin) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'Cross-origin Sage execution is not allowed.' }));
      return;
    }
    try {
      const body = await readJsonBody(request);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) throw new Error('Sage code is required.');
      if (code.length > 8_000) throw new Error('Sage input is limited to 8,000 characters.');
      const result = await executeSage(code);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }
  if (pathname === '/api/catalog') {
    try {
      const { families } = await buildCatalog();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ families }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (pathname === '/api/development-context') {
    try {
      const context = await buildDevelopmentContext();
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(context));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (pathname === '/api/file') {
    await serveRepositoryFile(searchParams.get('path') || '', response);
    return;
  }
  if (pathname.startsWith('/source/pdf/')) {
    await servePdf(decodeURIComponent(pathname.slice('/source/pdf/'.length)), response);
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  const stream = createReadStream(target);
  stream.once('open', () => {
    response.writeHead(200, {
      'Content-Type': mime[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    stream.pipe(response);
  });
  stream.once('error', () => response.writeHead(404).end('Not found'));
}).listen(port, '127.0.0.1', () => {
  console.log(`Diophantine Review Workbench: http://127.0.0.1:${port}`);
});
