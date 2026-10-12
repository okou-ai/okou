# UI 层级设计

先确定覆盖范围和交互，再考虑 `z-index`。本指南结合 Web 机制与
[项目约定](styles.md#stacking-ownership)；组件 API 和具体数值属于项目选择。
统一的层级 token 也是可行方案。

## 核心原则

- 区分定位、裁剪和层叠。增大 z-index 无法突破祖先的层叠上下文或裁剪；
  transform 也可能限制 fixed 元素的定位范围。
- 优先利用布局和绘制顺序。仅在需要局部层叠上下文时使用 `isolate`，
  并将所有参与层级比较的控件放在其中。
- 浮层行为由共享组件负责。Portal 只改变 DOM 挂载位置，
  不保证显示在最上层，也不自动提供焦点管理或模态行为。

## 按场景选择

| 场景                         | 推荐写法                                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面、表单、装饰             | 使用普通文档流；装饰元素不拦截交互。                                                                                                                                             |
| 图片或卡片上的控件           | 局部定位；仅在必要时隔离层叠上下文并设置顺序。                                                                                                                                   |
| 整张卡片可点击               | 主、次操作使用同级控件；内容需支持文本选择时，优先提供明确的链接或按钮。[卡片示例](../../turbo/apps/platform/src/views/okou-page/components/settings/connector-entry-card.tsx)。 |
| 吸顶表头、冻结列             | 共用一个滚动容器，表头使用不透明背景；行列交叉角位于两者之上。[表头示例](../../turbo/apps/platform/src/views/okou-page/components/org-manage/org-invoices-tab.tsx)。             |
| 保存栏、页脚                 | 优先使用布局内页脚或 sticky；fixed 需预留安全区域和内容空间。[UnsavedBar](../../turbo/apps/platform/src/views/okou-page/unsaved-bar.tsx)。                                       |
| 菜单、浮动面板、选择器、提示 | 复用共享组件，不抬高触发器层级。[DropdownMenu](../../turbo/packages/ui/src/components/ui/dropdown-menu.tsx)。                                                                    |
| 对话框、抽屉、嵌套弹层       | 保持正确的嵌套关系、焦点、遮罩顺序和关闭行为。[Dialog](../../turbo/packages/ui/src/components/ui/dialog.tsx)。                                                                   |
| 应用内全屏                   | 选择合适的应用外壳挂载点，保持内容组件身份稳定。[FullscreenPanel](../../turbo/packages/ui/src/components/ui/fullscreen-panel.tsx)。                                              |
| 浏览器原生全屏               | 普通浮层应挂在全屏元素内，使用 `DialogContent.portalContainer` 等受支持的 API。                                                                                                  |
| 加载遮罩、拖拽拦截层、通知   | 明确覆盖范围和是否拦截交互；通知使用共享服务，所有退出路径都要清理。                                                                                                             |

原生模态对话框和已打开的 popover 使用浏览器顶层（top layer）；popover 是非模态的。
全屏挂载点与状态保持的细节见[样式指南](styles.md#floating-layers-and-portal-ownership)。

## 验收要点

- 检查实际遮挡和点击目标，包括容器空白区域。
  `opacity: 0` 和 `pointer-events: none` 本身不会阻止元素获得键盘焦点。
- 检查 Tab、Escape、焦点返回和不同界面之间的焦点交接；
  模态界面的背景内容必须不可交互。
- 覆盖滚动、窄屏、矮屏、缩放、安全区域、软键盘展开和全屏状态。
  iOS PWA 行为需在对应环境中验证。
- 反复关闭或取消，确认释放滚动锁、拦截层和监听器，并保留内容状态和阅读位置。
  修复缺陷时补充浏览器回归测试。

## 参考资料

- MDN：[层叠上下文](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Positioned_layout/Stacking_context)、[定位](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position)、[浏览器顶层](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer)。
- [WAI-ARIA 模态对话框模式](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)。
- [React Portal](https://react.dev/reference/react-dom/createPortal)。
- [Base UI Portal 配置](https://base-ui.com/react/overview/quick-start#portals)。
- [Material UI z-index 层级](https://mui.com/material-ui/customization/z-index/)。
