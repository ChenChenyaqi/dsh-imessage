// @vitest-environment jsdom
//
// useCardForm 规格（测试先行）：订阅宿主表单，产出 saved 基准与 mutate 面。
// 迁移自 controller.test 的 snapshot binding / saving 段语义。

import { describe, expect, it } from 'vitest';

import { useCardForm } from '@/client/settings/useCardForm';
import { makeCardForm } from '../../helpers/fake-card-form';
import { act, renderHook } from '../../helpers/render-hook';

describe('useCardForm', () => {
  it('starts ready with the first snapshot as saved baseline', () => {
    const fake = makeCardForm({ locale: 'en', allowlist: ['+8613800000000'] });
    const { result } = renderHook(() => useCardForm(fake.form));

    expect(result.current.saved).toEqual({
      locale: 'en',
      allowlist: ['+8613800000000'],
      chunkedReplies: false,
      maxChunks: 8,
      delayFactor: 1,
      agentPreset: undefined, // 未设置 = undefined（不造默认；preset 域自己解析意图）
    });
  });

  it('follows host pushes', () => {
    const fake = makeCardForm({ locale: 'zh' });
    const { result } = renderHook(() => useCardForm(fake.form));

    act(() => fake.push({ locale: 'en' }));

    expect(result.current.saved.locale).toBe('en');
  });

  it('forwards mutate ops and reports host rejection', async () => {
    const ok = makeCardForm({});
    const { result: okHook } = renderHook(() => useCardForm(ok.form));
    const ops = [{ op: 'set', path: ['locale'], value: 'en' }] as const;
    await act(async () => {
      await okHook.current.mutate(ops);
    });
    expect(ok.calls[0]).toBe(ops);

    const rejecting = makeCardForm({}, { mutateResult: false });
    const { result: badHook } = renderHook(() => useCardForm(rejecting.form));
    await act(async () => {
      await expect(badHook.current.mutate(ops)).resolves.toBe(false);
    });
  });
});
