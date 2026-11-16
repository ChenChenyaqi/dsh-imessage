// 卡片 context 规格：防御契约 —— 漏 Provider 时快失败。

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { useCardContext } from '@/client/settings/card-context';
import { renderHook } from '../../helpers/render-hook';

describe('card context', () => {
  it('throws when a domain hook runs outside CardProvider', () => {
    // 渲染期抛错优于静默读 undefined（错进宿主服务）
    expect(() => renderHook(() => useCardContext())).toThrow(/requires CardProvider/);
  });
});
