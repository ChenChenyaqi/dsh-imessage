// 轻量 i18n（D6：zh/en 起步）。
//
// 面向 iMessage 回复给用户的文案。Error message 与日志一律英文、
// 不走本层。词条用扁平 key（'common.error'），新增词条两个语言
// 同步添加；漏译时回退到另一语言，两边都缺则返回 key 本身
// （可见、可搜索、不会炸）。

export type Locale = 'zh' | 'en';

export const LOCALES: readonly Locale[] = ['zh', 'en'];

/** 插值参数：{name} 形式的占位符替换。 */
export type TParams = Readonly<Record<string, string | number>>;

// ---------------------------------------------------------------------------
// 词条表。新增功能时同步补两个语言，保持 key 排序随意但成对出现。
// ---------------------------------------------------------------------------

const messages: Record<Locale, Readonly<Record<string, string>>> = {
  zh: {
    'common.error': '出错了，请稍后再试',
    'common.notReady': '我还没准备好，请稍后再试',
    'common.unknownCommand': '不认识的命令：{command}',
  },
  en: {
    'common.error': 'Something went wrong, please try later',
    'common.notReady': "I'm not ready yet, please try later",
    'common.unknownCommand': 'Unknown command: {command}',
  },
};

/** 替换 {placeholder} 占位符。多余参数忽略，缺失占位符保留原样。 */
function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export type TFunction = (key: string, params?: TParams) => string;

/** 供测试与诊断：各语言的词条 key 列表（排序、冻结）。 */
export function messageKeys(): Record<Locale, readonly string[]> {
  return {
    zh: Object.freeze(Object.keys(messages.zh).sort()),
    en: Object.freeze(Object.keys(messages.en).sort()),
  };
}

/** 创建绑定语言实例的翻译函数。 */
export function makeT(locale: Locale): TFunction {
  const fallback: Locale = locale === 'zh' ? 'en' : 'zh';
  return (key, params) => {
    const template = messages[locale][key] ?? messages[fallback][key] ?? key;
    return interpolate(template, params);
  };
}
