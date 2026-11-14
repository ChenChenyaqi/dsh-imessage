// 设置入口的身份常量（入口、挂载、controller、测试共用一处，避免字符串漂移）。

/** 设置菜单条目 id（纯 UI 身份）。 */
export const SECTION_ID = 'dsh-imessage';

/** 配置命名空间 = profile patch 里的 entry id（configForms.get 的入参）。
 *  真机踩坑：误用菜单 id 会拿到空快照，界面永远显示空配置。 */
export const ENTRY_ID = 'chenchenyaqi-dsh-imessage';

/** 菜单排序：落在内置插件之后（官方段位 -10..40）。 */
export const SECTION_ORDER = 50;

/** 词条命名空间（我们自己的 i18n 字典 key）。 */
export const LOCALE_NAMESPACE = 'settings.imessage';
