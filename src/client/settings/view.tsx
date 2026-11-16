// 设置卡片组合视图（方案 D）：静态组合树 —— 各域组件自治
// （hook 就地执行、词条从 context 自取），这里只负责布局与根标记。

import { AllowlistSection } from './allowlist/AllowlistSection';
import { ChunkedSection } from './chunked/ChunkedSection';
import { LocaleSelect } from './locale/LocaleSelect';
import { PresetSelect } from './preset/PresetSelect';
import { SaveBar } from './save-bar/SaveBar';

/** 卡片整体布局（data-dsh-imessage-card 是 e2e 的 DOM 契约，不许丢）。 */
export function SettingsCardView() {
  return (
    <div style={{ maxWidth: '520px' }} data-dsh-imessage-card="">
      <LocaleSelect />
      <AllowlistSection />
      <ChunkedSection />
      <PresetSelect />
      <SaveBar />
    </div>
  );
}
