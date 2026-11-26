// buildPeerNote 文案矩阵。文案 zh 硬编码：prompt 是 AI 输入，
// i18n 层只覆盖出站用户文本（M6.3 引用块同款边界）。
//
// 「记名字」指引（dsh-im 版有）在此不出现：分叉①定案 α——称呼归
// 设置页管，AI 不写文件。

import { describe, expect, it } from 'vitest';

import { buildPeerNote, MAX_PEER_NAME_LENGTH } from '@/core/identity/peer-note';

describe('buildPeerNote', () => {
  it('names the handle with the recorded nickname', () => {
    const note = buildPeerNote({ handle: '+8613800000000', name: '小陈' });
    expect(note).toContain('[对话来源]');
    expect(note).toContain('对方是小陈（+8613800000000）');
    expect(note).toContain('认不出是谁就直说，别瞎猜');
  });

  it('admits an unknown name instead of guessing', () => {
    const note = buildPeerNote({ handle: '+8613800000000' });
    expect(note).toContain('对方是+8613800000000（还不知道叫什么，可以问）');
  });

  it('truncates a long nickname to the injection budget', () => {
    const long = '名'.repeat(MAX_PEER_NAME_LENGTH + 20);
    const note = buildPeerNote({ handle: '+8613800000000', name: long });
    expect(note).toContain(`对方是${'名'.repeat(MAX_PEER_NAME_LENGTH)}（+8613800000000）`);
  });

  it('treats a blank nickname as unknown', () => {
    const note = buildPeerNote({ handle: '+8613800000000', name: '   ' });
    expect(note).toContain('还不知道叫什么，可以问');
  });

  it('returns an empty note (never published) for a blank handle', () => {
    expect(buildPeerNote({ handle: '', name: '小陈' })).toBe('');
    expect(buildPeerNote({ handle: '   ', name: '小陈' })).toBe('');
  });
});
