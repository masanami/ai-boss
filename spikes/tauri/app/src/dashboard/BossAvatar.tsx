import type { BossExpression } from "./boss-expression";
import bossNormal from "./assets/boss/boss-normal.svg";
import bossSatisfied from "./assets/boss/boss-satisfied.svg";
import bossDispleased from "./assets/boss/boss-displeased.svg";
import bossEncouraging from "./assets/boss/boss-encouraging.svg";

interface BossAvatarProps {
  expression: BossExpression;
}

// 表情キー→画像のマッピングをここ1箇所に集約する。画像差し替えはこのオブジェクトのみで完結する。
const EXPRESSION_IMAGE: Record<BossExpression, string> = {
  normal: bossNormal,
  satisfied: bossSatisfied,
  displeased: bossDispleased,
  encouraging: bossEncouraging,
};

const EXPRESSION_LABEL: Record<BossExpression, string> = {
  normal: "通常",
  satisfied: "満足",
  displeased: "不機嫌",
  encouraging: "激励",
};

function BossAvatar({ expression }: BossAvatarProps) {
  return (
    <img
      className="boss-avatar"
      src={EXPRESSION_IMAGE[expression]}
      alt={EXPRESSION_LABEL[expression]}
    />
  );
}

export default BossAvatar;
