# Stage 1: Base toolchain for CI/CD and minimal development
FROM ubuntu:25.10 AS toolchain

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies and jq
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gnupg \
    lsb-release \
    ca-certificates \
    wget \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN node --version

# Install global npm packages for CI/CD
# Note: vercel and neonctl are installed in jobs that need them
RUN npm install -g pnpm@10.15.0 lefthook@1.12.3

# Stage 2: Toolchain with Rust for cross-compilation
FROM toolchain AS toolchain-rust

# Stage-2 apt prerequisites:
#   build-essential — host gcc/g++/libc-dev for cargo to compile build.rs
#       and proc-macro crates (needed by `cargo install` below and by any
#       downstream `cargo build`);
#   xz-utils        — extract the Bootlin tarball;
#   libatomic1      — runtime dependency of the mold linker binary;
#   zstd            — multi-threaded GitHub Actions cache compression.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    xz-utils \
    libatomic1 \
    zstd \
    && zstd --version \
    && unzstd --version \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain with runner Linux musl targets.
# Used for building runner and guest binaries for Firecracker VMs.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup target add aarch64-unknown-linux-musl x86_64-unknown-linux-musl \
    && rustup component add rustfmt clippy \
    && rm -rf /usr/local/rustup/toolchains/*/share/doc \
    && rm -rf /usr/local/rustup/toolchains/*/share/man \
    && rustc --version && cargo --version

# Install musl compilers for runner Linux targets. Using a glibc
# cross-gcc directly would make cc crate compile C sources with glibc
# headers, which expand stdlib calls to _FORTIFY_SOURCE-hardened
# __*_chk variants that don't exist in musl libc, causing link failures
# when rustc statically links the musl runtime.
#
# amd64 hosts use the existing Bootlin stable toolchain for aarch64
# cross-compilation and Ubuntu's musl-dev wrapper for native x86_64 musl
# builds. Bootlin's binary is named aarch64-buildroot-linux-musl-gcc, so
# we symlink it to aarch64-linux-musl-gcc which is the name cc crate
# probes for the aarch64-unknown-linux-musl target.
#
# arm64 hosts use Ubuntu's musl-dev wrapper for native aarch64 musl
# builds. They also install x86_64 GNU cross-gcc and extract the amd64
# musl-dev package contents to provide x86_64 musl headers, libs, specs,
# and wrapper without executing Bootlin's x86_64-host compiler binaries.
# Ubuntu's musl wrappers can pass a `-dynamic-linker` argument even under
# `-static`, so runner and guest targets pass `-Wl,--no-dynamic-linker`
# via crates/.cargo/config.toml to keep fully static output independent
# of host musl loader paths.
ARG MUSL_CROSS_VERSION=2025.08-1
ARG MUSL_CROSS_SHA256=defba831ffa1175236f137069333e21ed46d4d19feb5080a90cf248b6fc2cb08
ARG MUSL_DEV_AMD64_URL=https://archive.ubuntu.com/ubuntu/pool/universe/m/musl/musl-dev_1.2.4-2_amd64.deb
ARG MUSL_DEV_AMD64_SHA256=4b451ecb6a0f8469883058cf22a807f3bd9cc16d115cc08b7efc35fe8eb44db2
ENV PATH="/opt/aarch64--musl--stable-${MUSL_CROSS_VERSION}/bin:${PATH}"
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
        amd64) \
            apt-get update \
            && apt-get install -y --no-install-recommends musl-dev \
            && rm -rf /var/lib/apt/lists/* \
            && curl -fsSL --retry 3 "https://toolchains.bootlin.com/downloads/releases/toolchains/aarch64/tarballs/aarch64--musl--stable-${MUSL_CROSS_VERSION}.tar.xz" -o /tmp/musl-cross.tar.xz \
            && echo "${MUSL_CROSS_SHA256}  /tmp/musl-cross.tar.xz" | sha256sum -c - \
            && tar xJf /tmp/musl-cross.tar.xz -C /opt \
            && rm /tmp/musl-cross.tar.xz \
            && cd "/opt/aarch64--musl--stable-${MUSL_CROSS_VERSION}/bin" \
            && for f in aarch64-buildroot-linux-musl-*; do ln -s "$f" "aarch64-linux-musl-${f#aarch64-buildroot-linux-musl-}"; done \
            ;; \
        arm64) \
            apt-get update \
            && apt-get install -y --no-install-recommends musl-dev gcc-x86-64-linux-gnu \
            && rm -rf /var/lib/apt/lists/* \
            && curl -fsSL --retry 3 "${MUSL_DEV_AMD64_URL}" -o /tmp/musl-dev-amd64.deb \
            && echo "${MUSL_DEV_AMD64_SHA256}  /tmp/musl-dev-amd64.deb" | sha256sum -c - \
            && dpkg-deb -x /tmp/musl-dev-amd64.deb /tmp/musl-dev-amd64 \
            && cp -a /tmp/musl-dev-amd64/usr/include/x86_64-linux-musl /usr/include/ \
            && cp -a /tmp/musl-dev-amd64/usr/lib/x86_64-linux-musl /usr/lib/ \
            && install -m 0755 /tmp/musl-dev-amd64/usr/bin/x86_64-linux-musl-gcc /usr/bin/x86_64-linux-musl-gcc \
            && rm -rf /tmp/musl-dev-amd64 /tmp/musl-dev-amd64.deb \
            ;; \
        *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
    && aarch64-linux-musl-gcc --version \
    && x86_64-linux-musl-gcc --version

# Install mold linker for faster linking of the runner crate.
# The target-prefixed ld.mold symlinks are required so the musl gcc
# wrappers in crates/.cargo/config.toml can find mold under the linker
# names they probe for `-fuse-ld=mold`. mold 2.x supports cross-linking
# from any host, so a single host-native binary works for both targets.
ARG MOLD_VERSION=2.41.0
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
        amd64) MOLD_ARCH="x86_64" ;; \
        arm64) MOLD_ARCH="aarch64" ;; \
        *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/rui314/mold/releases/download/v${MOLD_VERSION}/mold-${MOLD_VERSION}-${MOLD_ARCH}-linux.tar.gz" \
       | tar xz --strip-components=2 -C /usr/local/bin "mold-${MOLD_VERSION}-${MOLD_ARCH}-linux/bin/mold" \
    && ln -sf /usr/local/bin/mold /usr/local/bin/ld.mold \
    && ln -sf /usr/local/bin/mold /usr/local/bin/aarch64-linux-musl-ld.mold \
    && ln -sf /usr/local/bin/mold /usr/local/bin/aarch64-linux-gnu-ld.mold \
    && ln -sf /usr/local/bin/mold /usr/local/bin/x86_64-linux-musl-ld.mold \
    && ln -sf /usr/local/bin/mold /usr/local/bin/x86_64-linux-gnu-ld.mold \
    && mold --version

RUN rustup target list --installed | grep -qx aarch64-unknown-linux-musl \
    && rustup target list --installed | grep -qx x86_64-unknown-linux-musl \
    && printf 'int main(void) { return 0; }\n' > /tmp/toolchain-smoke.c \
    && for TARGET in aarch64-linux-musl x86_64-linux-musl; do \
        command -v "${TARGET}-gcc"; \
        command -v "${TARGET}-ld.mold"; \
        "${TARGET}-gcc" -static -fuse-ld=mold -Wl,--no-dynamic-linker /tmp/toolchain-smoke.c -o "/tmp/${TARGET}-smoke"; \
        test -x "/tmp/${TARGET}-smoke"; \
    done \
    && rm -f /tmp/toolchain-smoke.c /tmp/*-linux-musl-smoke

# Install Python3 and Ansible for runner deployments via SSH.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    ansible-core \
    && rm -rf /var/lib/apt/lists/*

# Stage 3: Development environment with additional tools
FROM toolchain-rust AS development

# Install development tools and user requirements
RUN apt-get update && apt-get install -y \
    sudo \
    zsh \
    vim \
    gawk \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install vercel and neonctl for development
RUN npm install -g vercel@48.11.0 neonctl@2.15.0


# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install libnss3-tools (needed by Chromium NSS database)
RUN apt-get update && apt-get install -y \
    libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

# Install 1Password CLI
RUN curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | tee /etc/apt/sources.list.d/1password.list \
    && mkdir -p /etc/debsig/policies/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol | tee /etc/debsig/policies/AC2D62742012EA22/1password.pol \
    && mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg \
    && apt-get update \
    && apt-get install -y 1password-cli \
    && rm -rf /var/lib/apt/lists/*

# Install agent-browser for browser automation
RUN npm install -g agent-browser@0.22.0

# Install Chromium via Playwright (supports both amd64 and arm64)
# Use chrome-for-testing to ensure full browser (not just headless shell)
# is downloaded, needed for headed mode (AGENT_BROWSER_HEADED=1)
RUN npx -y playwright@1.59.1 install-deps chromium \
    && npx -y playwright@1.59.1 install chrome-for-testing

# Symlink Chromium binary to a stable path for agent-browser
# Grant world read+execute so non-root users (e.g. vscode) can launch Chrome
RUN CHROMIUM_PATH=$(find /root/.cache/ms-playwright/chromium-*/chrome-linux* -type f -name chrome 2>/dev/null | head -1) \
    && test -n "$CHROMIUM_PATH" || { echo "ERROR: Chromium not found"; ls -laR /root/.cache/ms-playwright/; exit 1; } \
    && ln -sf "$CHROMIUM_PATH" /usr/local/bin/playwright-chromium \
    && chmod o+x /root /root/.cache /root/.cache/ms-playwright \
    && chmod -R o+rX /root/.cache/ms-playwright/

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/playwright-chromium

# Install AWS CLI v2
RUN apt-get update && apt-get install -y unzip \
    && ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    fi \
    && unzip awscliv2.zip \
    && sudo ./aws/install \
    && rm -rf awscliv2.zip aws/ \
    && rm -rf /var/lib/apt/lists/*

# Create vscode user with standard UID/GID for devcontainer compatibility
# Following Microsoft's devcontainer pattern for better feature compatibility
# Ubuntu 24.04 base images already include a UID/GID 1000 user/group, so
# rename/reuse it instead of creating a duplicate UID.
RUN existing_group="$(getent group 1000 | cut -d: -f1 || true)" \
    && if [ -n "$existing_group" ] && [ "$existing_group" != "vscode" ]; then groupmod --new-name vscode "$existing_group"; fi \
    && if [ -z "$existing_group" ]; then groupadd --gid 1000 vscode; fi \
    && existing_user="$(getent passwd 1000 | cut -d: -f1 || true)" \
    && if [ -n "$existing_user" ] && [ "$existing_user" != "vscode" ]; then usermod --login vscode --home /home/vscode --move-home --shell /usr/bin/zsh --gid vscode "$existing_user"; fi \
    && if [ -z "$existing_user" ]; then useradd --uid 1000 --gid vscode --shell /usr/bin/zsh --create-home vscode; fi \
    && if [ "$existing_user" = "vscode" ]; then usermod --shell /usr/bin/zsh --gid vscode vscode; fi \
    && echo "vscode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode \
    && mkdir -p /home/vscode/.local/share /home/vscode/.local/share/agent-browser /home/vscode/.cache /home/vscode/.config \
    && chown -R vscode:vscode /home/vscode

# Install rust-src for rust-analyzer (IDE support for standard library)
RUN rustup component add rust-src

# Install Caddy web server with Cloudflare DNS module for automatic Let's Encrypt certificates
# Uses xcaddy to build a custom Caddy binary with the caddy-dns/cloudflare plugin
RUN GOLANG_VERSION=1.24.4 \
    && ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://go.dev/dl/go${GOLANG_VERSION}.linux-${ARCH}.tar.gz" -o /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && export PATH="/usr/local/go/bin:$PATH" \
    && export GOPATH="/tmp/gopath" \
    && go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest \
    && "$GOPATH/bin/xcaddy" build --with github.com/caddy-dns/cloudflare --output /usr/local/bin/caddy \
    && chmod +x /usr/local/bin/caddy \
    && rm -rf /tmp/go.tar.gz /tmp/gopath /usr/local/go

# Install Cloudflared tunnel client via apt (matches joedmck/devcontainer-features/cloudflared)
RUN mkdir -p /usr/share/keyrings \
    && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflared.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends cloudflared \
    && rm -rf /var/lib/apt/lists/*

# Install noVNC stack for remote browser viewing
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    i3 \
    novnc \
    x11-xserver-utils \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i "s/UI.initSetting('resize', 'off')/UI.initSetting('resize', 'remote')/" /usr/share/novnc/app/ui.js \
    && sed -i "s/UI.initSetting('reconnect', false)/UI.initSetting('reconnect', true)/" /usr/share/novnc/app/ui.js

# Install cargo-llvm-cov for Rust test coverage
RUN cargo install cargo-llvm-cov --locked \
    && rustup component add llvm-tools-preview

# Install Stripe CLI for local webhook forwarding during development
RUN curl -s https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public | gpg --dearmor -o /usr/share/keyrings/stripe.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" | tee /etc/apt/sources.list.d/stripe.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends stripe \
    && rm -rf /var/lib/apt/lists/*

# Install tmux for terminal multiplexing
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Install PostgreSQL and pgvector for local development.
ARG POSTGRES_VERSION=17
RUN install -d /usr/share/postgresql-common/pgdg \
    && curl -fsS \
        -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && printf '%s\n' \
        'Types: deb' \
        'URIs: https://apt.postgresql.org/pub/repos/apt' \
        "Suites: ${VERSION_CODENAME}-pgdg" \
        "Architectures: $(dpkg --print-architecture)" \
        'Components: main' \
        'Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' \
        > /etc/apt/sources.list.d/pgdg.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        "postgresql-${POSTGRES_VERSION}-pgvector" \
    && test -f "/usr/lib/postgresql/${POSTGRES_VERSION}/lib/vector.so" \
    && rm -rf /var/lib/apt/lists/*

# Default command
CMD ["/usr/bin/zsh"]
