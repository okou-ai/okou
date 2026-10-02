# Cloudflare Access service token for SSH tunnel
CF_ACCESS_CLIENT_ID=op://Development/vm0/CF_ACCESS_CLIENT_ID_METAL
CF_ACCESS_CLIENT_SECRET=op://Development/vm0/CF_ACCESS_CLIENT_SECRET_METAL

# Cloudflare API token for DNS (Let's Encrypt) and Tunnel management (Zone:DNS:Edit + Account:Tunnel:Edit on vm7.ai)
CF_DNS_AND_TUNNEL_API_TOKEN=op://Development/cloudflare/CF_DNS_AND_TUNNEL_API_TOKEN
CF_ACCOUNT_ID=op://Development/cloudflare/CF_ACCOUNT_ID

# Cloudflare API token scoped to deploying the zero hosted-sites Worker
CF_ZERO_HOST_WORKER_DEPLOY_API_TOKEN=op://Development/cloudflare/CF_ZERO_HOST_WORKER_DEPLOY_API_TOKEN

# Metal host for runner deployment (e.g. dev-1.aws.vm3.ai)
RUNNER_LOCAL_HOST=op://Development/vm0/RUNNER_LOCAL_HOST
OFFICIAL_RUNNER_SECRET=0000000000000000000000000000000000000000000000000000000000000000

# R2 image cache for `pnpm runner` (leave all four empty to skip — rootfs will be rebuilt locally)
R2_ACCOUNT_ID=op://Development/cloudflare/R2_ACCOUNT_ID
R2_ACCESS_KEY_ID=op://Development/cloudflare/R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_SECRET_ACCESS_KEY
R2_USER_STORAGES_BUCKET_NAME=op://Development/cloudflare/R2_USER_STORAGES_BUCKET_NAME

# R2 static assets for local CLI uploads
R2_STATIC_ACCESS_KEY_ID=op://Development/cloudflare/R2_STATIC_ACCESS_KEY_ID
R2_STATIC_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_STATIC_SECRET_ACCESS_KEY

# Configure scoped private-bucket credentials before enabling privateArtifacts.
R2_PRIVATE_ARTIFACTS_BUCKET_NAME=user-artifact-private-dev
R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID=
R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY=
R2_USER_ARTIFACTS_BUCKET_NAME=user-artifact-dev
R2_USER_ARTIFACTS_ACCESS_KEY_ID=op://Development/cloudflare/R2_USER_ARTIFACTS_ACCESS_KEY_ID
R2_USER_ARTIFACTS_SECRET_ACCESS_KEY=op://Development/cloudflare/R2_USER_ARTIFACTS_SECRET_ACCESS_KEY
PUBLIC_ARTIFACTS_BASE_URL=https://cdn.vm7.io
