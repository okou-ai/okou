import { settingsIconAssetUrl } from "./settings/settings-icon-assets.ts";

const slackIconImg = settingsIconAssetUrl("slack");

/**
 * The Slack mark, drawn the way the nav rail draws it: the artwork carries its
 * own padding, so it is scaled up inside a box the size we actually want.
 *
 * 16px everywhere, because Button and DropdownMenuItem both enforce
 * `[&_svg]:size-4` on their descendants and the marks have to agree with it.
 */
export function SlackMark({ size }: { size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <img
        src={slackIconImg}
        alt=""
        className="scale-[2.2]"
        style={{ width: size, height: size }}
      />
    </span>
  );
}
