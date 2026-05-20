# bans.fyi

A minimal GitHub-backed Markdown knowledge base.

- Frontend: Vite + vanilla TypeScript, hosted on GitHub Pages.
- Backend: Cloudflare Worker.
- Content: Markdown files inside `content/**/*.md`.
- Auth: GitHub OAuth login, restricted to one GitHub username.

## Required setup

### 1. GitHub repository

Repository: `bans.fyi`

Enable GitHub Pages:

- Settings → Pages
- Source: GitHub Actions

### 2. GitHub OAuth App

Create an OAuth App in GitHub:

- Homepage URL: `https://bans.fyi`
- Authorization callback URL: `https://api.bans.fyi/api/auth/callback`

Store the generated client ID and client secret in Cloudflare Worker secrets.

### 3. GitHub token for repository writes

Create a fine-grained GitHub token with access only to this repository and permission:

- Contents: Read and write
- Metadata: Read

Store it as `GITHUB_REPO_TOKEN` in Cloudflare Worker secrets.

### 4. Cloudflare Worker secrets

Set these Worker secrets/vars:

```txt
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_ALLOWED_USER
GITHUB_OWNER
GITHUB_REPO
GITHUB_BRANCH
GITHUB_REPO_TOKEN
SESSION_SECRET
APP_ORIGIN
```

Recommended values:

```txt
GITHUB_ALLOWED_USER=your-github-username
GITHUB_OWNER=your-github-username-or-org
GITHUB_REPO=bans.fyi
GITHUB_BRANCH=main
APP_ORIGIN=https://bans.fyi
```

### 5. GitHub Actions secrets for Worker deployment

Add these repository secrets:

```txt
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Then push to `main`.

## Content

Only files under `content/**/*.md` are editable through the admin area.
