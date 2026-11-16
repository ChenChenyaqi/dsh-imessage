// 保存条（方案 D：hook 就地执行，词条从卡片 context 自取）：
// 最近一次保存错误 + 保存按钮。
//
// canSave 为什么是 false 是聚合派生的事，这里只做忠实渲染与点击转发。

import { Button } from '@deepseek-ai/dsh-client-ui-primitives';

import { useCardContext } from '../card-context';
import { errorStyle } from '../styles';
import { useSave } from '../useSave';

/** 错误行 + 保存按钮。 */
export function SaveBar() {
  const { messages } = useCardContext();
  const { canSave, saving, error, save } = useSave();

  return (
    <>
      {error !== null && <p style={errorStyle}>{error}</p>}
      <Button variant="primary" disabled={!canSave || saving} onClick={() => void save()}>
        {saving ? messages.saving : messages.save}
      </Button>
    </>
  );
}
