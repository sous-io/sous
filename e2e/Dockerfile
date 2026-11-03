# The image every end-to-end scenario runs in: plain Debian Node (git, bash and Corepack for
# pnpm and Yarn), plus an MCP client library for the front-end scenario. No token, no host
# file and no sous copy is baked in; the scenarios are mounted read-only at run time.
ARG NODE=24
FROM node:${NODE}

RUN corepack enable \
 && corepack prepare pnpm@latest --activate \
 && corepack prepare yarn@stable --activate

# The host command line tools `sous repo submit` needs. They read GITHUB_TOKEN and GITLAB_TOKEN
# from the environment, so nothing is logged in inside the image.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update -qq && apt-get install -y -qq gh >/dev/null \
 && rm -rf /var/lib/apt/lists/*
RUN TAG=$(curl -fsSL "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tag_name))') \
 && ARCH=$(dpkg --print-architecture | sed s/amd64/amd64/) \
 && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/${TAG}/downloads/glab_${TAG#v}_linux_${ARCH}.tar.gz" | tar -xz -C /usr/local bin/glab \
 && glab --version | head -1

RUN mkdir /opt/mcp-client && cd /opt/mcp-client \
 && npm init -y >/dev/null \
 && npm i @modelcontextprotocol/sdk 2>&1 | tail -1

# System-wide git settings. The credential helpers read the token from the environment when
# git asks, so no token is written anywhere. The pre-push hook refuses any push to a
# repository outside the allowlist in e2e/lib/allowlist.mjs.
RUN git config --system user.name "sous e2e" \
 && git config --system user.email "sous-e2e@example.com" \
 && git config --system init.defaultBranch main \
 && git config --system safe.directory '*' \
 && git config --system core.hooksPath /e2e/hooks \
 && git config --system 'credential.https://github.com.helper' '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f' \
 && git config --system 'credential.https://gitlab.com.helper' '!f() { echo username=oauth2; echo "password=${GITLAB_TOKEN:-$E2E_GITLAB_BEARER}"; }; f'

WORKDIR /work
