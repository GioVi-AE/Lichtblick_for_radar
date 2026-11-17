// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Minimal structural typings of the Lichtblick extension API (subset we use).
// Kept local so the extension has no dependency on private Lichtblick packages.

export interface Time {
  sec: number;
  nsec: number;
}

export interface Topic {
  name: string;
  schemaName: string;
  convertibleTo?: readonly string[];
}

export interface Subscription {
  topic: string;
  preload?: boolean;
  convertTo?: string;
}

export interface MessageEvent<T = unknown> {
  topic: string;
  schemaName: string;
  receiveTime: Time;
  publishTime?: Time;
  message: T;
  sizeInBytes: number;
  originalMessageEvent?: MessageEvent;
}

export interface RenderState {
  currentFrame?: readonly MessageEvent[];
  allFrames?: readonly MessageEvent[];
  didSeek?: boolean;
  topics?: readonly Topic[];
  currentTime?: Time;
  startTime?: Time;
  endTime?: Time;
  colorScheme?: "dark" | "light";
}

export type SettingsTreeField = {
  label?: string;
  help?: string;
  value?: unknown;
  readonly?: boolean;
  input: string;
  options?: { label: string; value: string | number | undefined }[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  precision?: number;
};

export interface SettingsTreeNode {
  label?: string;
  icon?: string;
  defaultExpansionState?: "collapsed" | "expanded";
  fields?: Record<string, SettingsTreeField | undefined>;
  children?: Record<string, SettingsTreeNode | undefined>;
}

export interface SettingsTreeActionUpdate {
  action: "update";
  payload: { path: readonly string[]; input: string; value: unknown };
}

export type SettingsTreeAction = SettingsTreeActionUpdate | { action: "perform-node-action" };

export interface SettingsTree {
  actionHandler: (action: SettingsTreeAction) => void;
  nodes: Record<string, SettingsTreeNode | undefined>;
}

export interface PanelExtensionContext {
  readonly panelElement: HTMLDivElement;
  readonly initialState: unknown;
  watch(field: keyof RenderState): void;
  saveState(state: unknown): void;
  subscribe(subscriptions: Subscription[]): void;
  unsubscribeAll(): void;
  onRender?: (renderState: RenderState, done: () => void) => void;
  updatePanelSettingsEditor(settings: SettingsTree): void;
  setDefaultPanelTitle(title: string | undefined): void;
  seekPlayback?: (time: number | Time) => void;
  setPreviewTime(time: number | undefined): void;
}

export interface ExtensionPanelRegistration {
  name: string;
  initPanel: (context: PanelExtensionContext) => void | (() => void);
}

export interface MessageConverterContext {
  [k: string]: unknown;
}

export interface RegisterMessageConverterArgs<Src> {
  fromSchemaName: string;
  toSchemaName: string;
  converter: (msg: Src, event: MessageEvent<Src>) => unknown;
}

export interface ExtensionContext {
  readonly mode: "production" | "development" | "test";
  registerPanel(registration: ExtensionPanelRegistration): void;
  registerMessageConverter<Src>(args: RegisterMessageConverterArgs<Src>): void;
}

export interface ExtensionModule {
  activate: (extensionContext: ExtensionContext) => void;
}
