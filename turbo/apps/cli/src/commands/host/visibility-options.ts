import { Option } from "commander";
import { hostedSiteAudiences } from "../../lib/host/visibility";

export function createHostedSiteVisibilityOption(): Option {
  return new Option(
    "--visibility <visibility>",
    "Who can access the site; email requires --email (defaults to only-me)",
  ).choices(Object.keys(hostedSiteAudiences));
}

export function createHostedSiteEmailOption(): Option {
  return new Option(
    "--email <address>",
    "Invite a complete email address with email visibility (repeatable)",
  ).argParser((value: string, previous: string[] = []) => {
    return [...previous, value];
  });
}
