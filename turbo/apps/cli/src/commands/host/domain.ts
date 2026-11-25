import { domainToASCII } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import { hostedSitePublicSlugSchema } from "@okouai/api-contracts/contracts/host";
import {
  addHostedSiteDomain,
  assertHostedSiteCustomDomains,
  getHostedSiteDomains,
  removeHostedSiteDomain,
  selectHostedSiteDomain,
  verifyHostedSiteDomain,
  type HostedSiteDomain,
  type HostedSiteDomainSettings,
} from "../../lib/api/domains/hosted-site-domains";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface DomainOptions {
  readonly json?: boolean;
  readonly default?: boolean;
}

const siteDescription = "Owned website's platform slug printed by okou host";
const hostnameDescription = "Exact hostname, for example www.example.com";
const domainFlow = `
Workflow:
  1. Publish your website with okou host, then use its platform Site slug below.
  2. Add one complete hostname:
       okou host domain add my-report www.example.com
  3. At your DNS provider, configure every returned TXT/CNAME/A/AAAA record exactly.
     For a root domain, follow the returned instructions and your provider's supported flattening.
  4. Verify once after configuring DNS:
       okou host domain verify my-report www.example.com
     Verification checks ownership, DNS, provider readiness, HTTPS, and website routing.
     It may return additional certificate TXT records. Configure them, allow DNS/HTTPS
     provisioning to finish, then explicitly run verify again. There is no automatic polling.
     Pending or failed verification prints the results and exits with code 1.
  5. Only after verification is ready, save the primary sharing address:
       okou host domain select my-report www.example.com

Management:
  Inspect settings and DNS:  okou host domain list my-report --json
  Restore the platform URL:  okou host domain select my-report --default
  Disconnect a domain:      okou host domain remove my-report www.example.com

Notes:
  - Requires OKOU_TOKEN with host:write and the same custom-domain feature switch as the App
  - Adding, verifying, and selecting a custom hostname require an active paid subscription
  - Only the website's owner can manage its domains
  - Use an exact hostname, not a URL, path, port, or wildcard such as *.example.com
  - Each hostname is verified separately; configuring example.com does not configure its subdomains
  - Read and copy the returned DNS records; never guess the target or certificate values
  - Selecting --default keeps connected domains active; use remove to revoke a binding and its sessions
  - Remove disconnects the provider configuration; afterward remove its DNS records at your DNS provider
  - Existing website visibility and private sign-in still apply on the custom domain
  - Concurrent edits are rejected. Run list to inspect current state before retrying; mutations are not automatically retried
  - Add --json for the full saved settings, DNS records, and verification results`;

function normalizeHostname(value: string): string {
  const input = value.trim().replace(/\.$/u, "");
  const message =
    "Use one exact hostname such as www.example.com, without a URL scheme, path, port, or wildcard";
  if (/[\\/:@?#*\s]/u.test(input)) {
    throw new Error(message);
  }
  const hostname = domainToASCII(input).toLowerCase();
  if (!/^[a-z0-9.-]+$/u.test(hostname) || !hostname.includes(".")) {
    throw new Error(message);
  }
  return hostname;
}

async function readSettings(site: string) {
  const publicSlug = hostedSitePublicSlugSchema.parse(site.trim());
  await assertHostedSiteCustomDomains();
  return { publicSlug, settings: await getHostedSiteDomains(publicSlug) };
}

function requireSubscription(settings: HostedSiteDomainSettings): void {
  if (!settings.allowed) {
    throw new ApiRequestError(
      "An active paid Okou subscription is required to connect and use custom domains",
      "PAID_PLAN_REQUIRED",
      402,
    );
  }
}

function findDomain(settings: HostedSiteDomainSettings, hostname: string) {
  const domain = settings.domains.find((item) => {
    return item.hostname === hostname;
  });
  if (!domain) {
    throw new Error(
      `Domain ${hostname} is not configured for this website. Run okou host domain list <site> to inspect its domains.`,
    );
  }
  return domain;
}

function printSettings(
  publicSlug: string,
  settings: HostedSiteDomainSettings,
  command: Command,
): void {
  if (command.optsWithGlobals<DomainOptions>().json) {
    console.log(JSON.stringify({ publicSlug, ...settings }));
    return;
  }
  console.log(`Website address: ${settings.effectiveUrl}`);
  if (settings.domains.length === 0) {
    console.log("No custom domains connected.");
    console.log(`Add one: okou host domain add ${publicSlug} www.example.com`);
    return;
  }
  for (const domain of settings.domains) {
    const status = domain.removing
      ? "disconnect cleanup pending"
      : domain.ready
        ? "ready"
        : "not ready";
    const primary = settings.selectedDomainId === domain.id ? " (primary)" : "";
    console.log(`\n${domain.hostname}${primary}: ${status}`);
    if (domain.verification) {
      for (const [name, check] of Object.entries(domain.verification.checks)) {
        console.log(`  ${name}: ${check.status} — ${check.message}`);
      }
    }
    console.log("  DNS records (type, name, value):");
    for (const record of domain.records) {
      console.log(`  ${record.type}\t${record.name}\t${record.value}`);
    }
  }
}

function requireReady(domain: HostedSiteDomain): void {
  if (!domain.ready || domain.removing) {
    throw new Error(
      "Domain is not ready. Configure all returned DNS records, allow DNS/HTTPS provisioning to finish, then explicitly run okou host domain verify <site> <hostname> again.",
    );
  }
}

export function createHostedSiteDomainCommand(): Command {
  const command = new Command("domain")
    .description(
      "Connect and manage verified custom domains for an owned website",
    )
    .option("--json", "Output the full domain settings and checks as JSON")
    .addHelpText("after", domainFlow);

  command.addCommand(
    new Command("list")
      .description(
        "Read connected hostnames, DNS records, and verification checks",
      )
      .argument("<site>", siteDescription)
      .option("--json", "Output the full domain settings and checks as JSON")
      .addHelpText("after", domainFlow)
      .action(
        withErrorHandler(
          async (site: string, _options: DomainOptions, cmd: Command) => {
            const { publicSlug, settings } = await readSettings(site);
            printSettings(publicSlug, settings, cmd);
          },
        ),
      ),
  );
  command.addCommand(
    new Command("add")
      .description("Create a hostname claim and print its DNS setup records")
      .argument("<site>", siteDescription)
      .argument("<hostname>", hostnameDescription)
      .option("--json", "Output the saved settings and DNS records as JSON")
      .addHelpText("after", domainFlow)
      .action(
        withErrorHandler(
          async (
            site: string,
            input: string,
            _options: DomainOptions,
            cmd: Command,
          ) => {
            const hostname = normalizeHostname(input);
            const { publicSlug, settings } = await readSettings(site);
            requireSubscription(settings);
            const saved = await addHostedSiteDomain(settings, hostname);
            findDomain(saved, hostname);
            printSettings(publicSlug, saved, cmd);
            if (!cmd.optsWithGlobals<DomainOptions>().json) {
              console.log(
                `\nConfigure the DNS records above, then run: okou host domain verify ${publicSlug} ${hostname}`,
              );
            }
          },
        ),
      ),
  );
  command.addCommand(
    new Command("verify")
      .description("Check a hostname once; exits 1 until all checks are ready")
      .argument("<site>", siteDescription)
      .argument("<hostname>", hostnameDescription)
      .option(
        "--json",
        "Output all DNS records and verification checks as JSON",
      )
      .addHelpText("after", domainFlow)
      .action(
        withErrorHandler(
          async (
            site: string,
            input: string,
            _options: DomainOptions,
            cmd: Command,
          ) => {
            const hostname = normalizeHostname(input);
            const { publicSlug, settings } = await readSettings(site);
            requireSubscription(settings);
            const saved = await verifyHostedSiteDomain(
              settings,
              findDomain(settings, hostname),
            );
            const domain = findDomain(saved, hostname);
            printSettings(publicSlug, saved, cmd);
            if (!domain.ready || domain.removing) {
              console.error(
                chalk.yellow(
                  "Domain is not ready. Apply the returned DNS records, allow DNS/HTTPS provisioning to finish, then explicitly run verify again.",
                ),
              );
              // Let stdout finish writing the verification JSON before exiting.
              process.exitCode = 1;
              return;
            }
            if (!cmd.optsWithGlobals<DomainOptions>().json) {
              console.log(
                chalk.green(
                  `\nVerified. Save this address: okou host domain select ${publicSlug} ${hostname}`,
                ),
              );
            }
          },
        ),
      ),
  );
  command.addCommand(
    new Command("select")
      .description(
        "Save a verified hostname or restore the platform sharing URL",
      )
      .argument("<site>", siteDescription)
      .argument("[hostname]", "Verified hostname; omit only with --default")
      .option(
        "--default",
        "Use the platform URL while keeping connected domains",
      )
      .option("--json", "Output the saved address and domain settings as JSON")
      .addHelpText("after", domainFlow)
      .action(
        withErrorHandler(
          async (
            site: string,
            input: string | undefined,
            options: DomainOptions,
            cmd: Command,
          ) => {
            if (Boolean(input) === Boolean(options.default)) {
              throw new Error("Choose either a hostname or --default");
            }
            const hostname =
              input === undefined ? null : normalizeHostname(input);
            const { publicSlug, settings } = await readSettings(site);
            const domain = hostname ? findDomain(settings, hostname) : null;
            if (domain) {
              requireSubscription(settings);
              requireReady(domain);
            }
            const saved = await selectHostedSiteDomain(
              settings,
              publicSlug,
              domain,
            );
            if (saved.selectedDomainId !== (domain?.id ?? null)) {
              throw new Error(
                "The API did not confirm the requested address. Run okou host domain list <site> before retrying.",
              );
            }
            printSettings(publicSlug, saved, cmd);
          },
        ),
      ),
  );
  command.addCommand(
    new Command("remove")
      .description(
        "Revoke a domain binding and remove its provider configuration",
      )
      .argument("<site>", siteDescription)
      .argument("<hostname>", hostnameDescription)
      .option("--json", "Output the remaining domain settings as JSON")
      .addHelpText("after", domainFlow)
      .action(
        withErrorHandler(
          async (
            site: string,
            input: string,
            _options: DomainOptions,
            cmd: Command,
          ) => {
            const hostname = normalizeHostname(input);
            const { publicSlug, settings } = await readSettings(site);
            const domain = findDomain(settings, hostname);
            const saved = await removeHostedSiteDomain(settings, domain);
            if (
              saved.domains.some((item) => {
                return item.id === domain.id;
              })
            ) {
              throw new Error(
                "Domain cleanup is not complete. Run okou host domain list <site> before retrying removal.",
              );
            }
            printSettings(publicSlug, saved, cmd);
            if (!cmd.optsWithGlobals<DomainOptions>().json) {
              console.log(
                `\nDisconnected ${hostname}. Remove its DNS records at your DNS provider.`,
              );
            }
          },
        ),
      ),
  );
  return command;
}
