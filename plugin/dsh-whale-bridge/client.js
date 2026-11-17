/**
 * dsh-whale-bridge —— DSH Web 客户端插件（纯浏览器 bundle，无构建步骤）
 *
 * 在 DSH Web 左侧栏注册「鲸鱼娘桥接」入口，并在 main 面板提供：
 * 桥接状态、DSH 选项（工作区/权限/模式/默认会话/端口）、高级上游模型设置、
 * 鲸鱼娘接入/还原、任务测试台、最近任务、任务 profile 重建；
 * 以及 DSH 原生聊天、鲸鱼娘调试台（/debug 搬入）、桥接人设（persona.md）编辑。
 *
 * 只依赖宿主页面模块表提供的 react；所有网络请求只打本机桥接服务
 * （默认 http://127.0.0.1:8789，端口可在面板里修改并记忆到 localStorage）。
 */
window.__ModuleLoader__.load({
    id: "dsh-whale-bridge",
    factory(require) {
        "use strict";

        var React = require("react");
        var h = React.createElement;
        var useState = React.useState;
        var useEffect = React.useEffect;
        var useRef = React.useRef;
        var useCallback = React.useCallback;

        /* ================================================================== */
        /* 常量（与 CONTRACT 对齐）                                            */
        /* ================================================================== */

        /** 侧边栏入口 id，同时是 main keyed slot 的 key。 */
        var PANEL_ID = "whale-bridge";
        /** locale 命名空间。 */
        var NS = "whaleBridge";
        /** 桥接服务 Origin（面板所有请求使用；端口默认 8789，可用 localStorage 覆盖）。 */
        var BRIDGE_ORIGIN = "http://127.0.0.1";
        /** 桥接默认端口（CONTRACT §3）。 */
        var DEFAULT_PORT = 8789;
        /** 面板记忆端口的 localStorage 键。 */
        var PORT_STORAGE_KEY = "dsh-whale-bridge.port";
        /** 状态/设置/任务列表/接入/还原等快速请求的超时（需求：每次请求 5s）。 */
        var QUICK_TIMEOUT_MS = 5000;
        var STATE_TIMEOUT_MS = 15000;
        /** 任务执行超时，对齐 CONTRACT §3 的默认 600000ms。 */
        var TASK_TIMEOUT_MS = 600000;
        /** 重建任务 profile 由 CLI 生成，给较长超时。 */
        var REBUILD_TIMEOUT_MS = 120000;
        /** 面板挂载期间的状态轮询间隔。 */
        var POLL_INTERVAL_MS = 5000;
        /** 鲸鱼娘网页默认地址。 */
        var DEFAULT_WHALE_URL = "http://127.0.0.1:8787/";
        /** 权限枚举（CONTRACT §3）。 */
        var PERMISSIONS = ["read-only", "workspace-write", "danger-full-access"];
        /** 模式枚举（CONTRACT §3）。 */
        var MODES = ["standard", "creator"];
        /** 思考强度枚举（settings.reasoningEffort；默认 max）。 */
        var REASONING_EFFORTS = ["low", "medium", "high", "max"];
        /** 样式表标记，便于宿主清理与 HMR。 */
        var STYLE_ID = "dsh-whale-bridge/client.css";

        /* ================================================================== */
        /* locale 字典（zh 为键全集；en 必须与 zh 键名一致）                    */
        /* ================================================================== */

        // <<<ZH
        var ZH = {
            "panel": "鲸鱼娘桥接",
            "title": "鲸鱼娘桥接",
            "intro": "管理鲸鱼娘 × DeepSeek Harness 桥接：查看状态、调整 DSH 选项、测试任务，并把鲸鱼娘接入 DSH。",
            "endpoint": "桥接端点：{url}",
            "loading": "正在读取…",
            "refresh": "刷新",
            "refreshing": "刷新中…",
            "lastUpdated": "最近刷新：{time}",
            "neverUpdated": "尚未刷新",
            "statusTitle": "连接状态",
            "bridgeTitle": "桥接服务",
            "whaleTitle": "鲸鱼娘",
            "dshTitle": "DSH 任务 profile",
            "labelName": "名称",
            "labelVersion": "版本",
            "labelPort": "端口",
            "labelUptime": "已运行",
            "labelDir": "目录",
            "labelProfile": "Profile",
            "labelState": "状态",
            "labelMode": "模式",
            "labelProvider": "Provider",
            "labelEndpoint": "接口地址",
            "labelRunning": "网页状态",
            "labelUpstream": "上游",
            "stateReady": "已就绪",
            "stateMissing": "未创建",
            "stateUnknown": "未知",
            "stateOnline": "在线",
            "stateOffline": "离线",
            "statePartial": "部分离线",
            "startChain": "一键启动全链路",
            "startingChain": "启动中…（最多 90 秒）",
            "chainTitle": "微信链路",
            "chainPlugin": "DSH 插件",
            "chainWhale": "鲸鱼娘",
            "chainBridge": "微信桥接",
            "chainAccount": "微信账号",
            "chainHeartbeat": "桥接心跳",
            "chainFailed": "启动失败：{error}",
            "configuredYes": "已指向桥接",
            "configuredNo": "未指向桥接",
            "runningYes": "运行中",
            "runningNo": "未运行",
            "healthError": "健康检查失败：{error}",
            "offlineTitle": "桥接服务未启动",
            "offlineHint": "请先在 DSH 里启用「鲸鱼娘桥接」插件（宿主侧会监听本机端口），然后点右上角「刷新」。若默认端口被占用，宿主会顺延端口启动，请把端口改成实际端口后点「使用此端口」。",
            "offlineDetail": "错误详情：{error}",
            "stateFetchError": "读取桥接状态失败：{error}",
            "statusErrorTitle": "状态读取失败",
            "optionsTitle": "DSH 选项",
            "optionsDesc": "桥接启动 DSH 任务时使用的默认设置，保存后对后续任务生效。",
            "fieldWorkspace": "工作区",
            "hintWorkspace": "DSH 子进程的工作目录，必须是存在的绝对路径。",
            "placeholderWorkspace": "例如 D:\\dsh_work",
            "fieldPermission": "权限",
            "hintPermission": "read-only 只读；workspace-write 允许修改工作区；danger-full-access 完全权限。",
            "optReadOnly": "只读（read-only）",
            "optWorkspaceWrite": "工作区可写（workspace-write）",
            "optDanger": "完全权限（danger-full-access）",
            "fieldMode": "模式",
            "hintMode": "standard 使用 headless 模板；creator 额外启用插件管理工具，任务可以改 DSH 插件。",
            "optStandard": "标准（standard）",
            "optCreator": "创造（creator）",
            "fieldTaskModel": "DSH 任务模型",
            "hintTaskModel": "留空 = 使用默认模型（deepseek-flash）",
            "placeholderTaskModel": "例如 deepseek-flash",
            "fieldReasoningEffort": "思考强度",
            "hintReasoningEffort": "越高越慢、消耗的思考 token 越多；保存后下次 DSH 任务生效",
            "optReasoningLow": "低（low）",
            "optReasoningMedium": "中（medium）",
            "optReasoningHigh": "高（high）",
            "optReasoningMax": "最高（max）",
            "mediaCardTitle": "媒体与文件",
            "mediaCardDesc": "媒体缓存清理与文件通道（网页附件上传 / 下载链接）设置。",
            "mediaGroupCacheTitle": "媒体缓存",
            "mediaGroupCacheDesc": "启动/定时清理 data/media-cache 里的旧图片、表情包、语音；对应鲸鱼娘 features.mediaCleanup 与 storage.mediaKeepDays / mediaMaxMB。",
            "mediaCleanup": "启用媒体缓存清理",
            "mediaCleanupHint": "关掉后媒体缓存不会自动清理，只受容量上限约束",
            "mediaKeepDays": "保留天数",
            "mediaKeepDaysHint": "超过这么多天的缓存会被清理（1-365 天）",
            "mediaMaxMB": "容量上限（MB）",
            "mediaMaxMBHint": "缓存总大小超过上限时优先清理最旧的（10-100000 MB）",
            "mediaReload": "重新加载",
            "mediaLoading": "读取中…",
            "mediaSave": "保存媒体设置",
            "mediaSaving": "保存中…",
            "mediaSaved": "媒体缓存设置已保存",
            "mediaSaveFail": "保存媒体设置失败：{error}",
            "mediaLoadFail": "读取媒体设置失败：{error}",
            "mediaBadKeepDays": "保留天数需要是 1-365 的整数",
            "mediaBadMaxMB": "容量上限需要是 10-100000 的整数",
            "filesGroupTitle": "文件通道",
            "filesGroupDesc": "鲸鱼娘网页「📎」上传与下载链接相关设置；写回桥接 settings.files。",
            "filesEnabled": "启用文件通道",
            "filesEnabledHint": "关掉后网页上传与下载链接都不可用",
            "filesAutoOutbox": "自动收集 DSH 产物",
            "filesAutoOutboxHint": "任务结束后自动把工作区 .whale-bridge/outbox 里的新文件做成下载链接",
            "filesMaxFileMB": "单文件上限（MB）",
            "filesMaxFileMBHint": "上传/下载的单个文件大小上限（1-500 MB）",
            "filesLinkTtlHours": "下载链接有效期（小时）",
            "filesLinkTtlHoursHint": "下载 token 的有效时间（1-720 小时）",
            "filesSave": "保存文件设置",
            "filesSaving": "保存中…",
            "filesSaved": "文件通道设置已保存",
            "filesSaveFail": "保存文件设置失败：{error}",
            "filesBadMaxFileMB": "单文件上限需要是 1-500 的整数",
            "filesBadLinkTtl": "下载链接有效期需要是 1-720 的整数",
            "fieldSession": "默认会话 ID",
            "hintSession": "留空则每次新会话；填写后可让同一聊天延续上下文。",
            "placeholderSession": "可留空",
            "fieldPort": "端口",
            "hintPort": "桥接监听端口，默认 8789。修改后保存，并在重启插件后生效；点「使用此端口」可立即切换本面板的连接目标。",
            "usePort": "使用此端口",
            "save": "保存",
            "saving": "保存中…",
            "saveOk": "设置已保存",
            "saveOkPort": "设置已保存；端口改为 {port}，重载插件后生效（之后点「使用此端口」切换本面板连接）",
            "saveFail": "保存失败：{error}",
            "invalidPort": "端口无效，应为 1–65535 的整数",
            "workspaceRequired": "工作区不能为空",
            "advancedTitle": "高级",
            "advancedDesc": "鲸鱼娘走桥接代理时使用的上游 OpenAI 兼容服务；不配置则沿用鲸鱼娘自己的上游。",
            "fieldUpstreamBaseUrl": "上游模型地址",
            "hintUpstreamBaseUrl": "OpenAI 兼容 baseUrl，例如 https://api.deepseek.com/v1；留空表示不覆盖。",
            "placeholderUpstreamBaseUrl": "https://api.deepseek.com/v1",
            "fieldUpstreamModel": "上游模型名",
            "hintUpstreamModel": "例如 deepseek-chat；留空表示不覆盖。",
            "placeholderUpstreamModel": "deepseek-chat",
            "fieldUpstreamKey": "上游 Key",
            "hintUpstreamKey": "保存后不回显；留空表示保留已配置的 Key。",
            "placeholderKeyConfigured": "已配置，留空则不修改",
            "placeholderKeyMissing": "未配置，请填写上游 API Key",
            "keyStatus": "上游 Key：{state}",
            "keyConfigured": "已配置",
            "keyMissing": "未配置",
            "saveUpstream": "保存上游设置",
            "savingUpstream": "保存中…",
            "upstreamSaveOk": "上游设置已保存",
            "upstreamSaveFail": "保存上游设置失败：{error}",
            "whaleSectionTitle": "鲸鱼娘接入",
            "whaleSectionDesc": "把鲸鱼娘的 provider 指向本桥接的 OpenAI 兼容代理；聊天里需要动手的任务就会交给 DSH。",
            "currentProvider": "当前接入",
            "adopt": "一键接入",
            "adopting": "接入中…",
            "revert": "还原",
            "reverting": "还原中…",
            "openWhale": "打开鲸鱼娘网页",
            "openDebug": "打开调试台",
            "whaleUrlHint": "网页地址：{url}",
            "adoptOk": "已接入；修改文件：{files}；备份目录：{backup}",
            "adoptFail": "接入失败：{error}",
            "revertOk": "已还原：{files}",
            "revertFail": "还原失败：{error}",
            "popupBlocked": "浏览器拦截了弹窗，请手动打开：{url}",
            "openFail": "打开失败：{error}",
            "openingWhale": "正在启动鲸鱼娘并打开…（首次启动需要几秒）",
            "openedWhale": "已打开：{url}",
            "openedWhaleStarted": "鲸鱼娘已启动，并已打开：{url}",
            "labelPid": "进程 PID",
            "startedByBridge": "由桥接启动",
            "startedByExternal": "由你手动启动",
            "startWhale": "启动鲸鱼娘",
            "stopWhale": "停止鲸鱼娘",
            "startingWhale": "启动中…",
            "stoppingWhale": "停止中…",
            "whaleStartOk": "鲸鱼娘已启动（PID {pid}）",
            "whaleAlreadyRunning": "鲸鱼娘已经在运行，没有重复启动",
            "whaleStopOk": "鲸鱼娘已停止（PID {pid}）",
            "whaleStopAlready": "鲸鱼娘本来就没在运行",
            "whaleOpFail": "操作失败：{error}",
            "benchTitle": "任务测试台",
            "benchDesc": "直接向桥接提交一个 DSH 任务，验证「DSH 侧」链路是否通畅。",
            "benchHint": "任务请求最长等待 10 分钟；状态、设置、任务列表等请求 5 秒超时。",
            "promptLabel": "任务内容",
            "promptPlaceholder": "例如：回答 1+1",
            "run": "运行",
            "runningBtn": "运行中…",
            "cancel": "取消",
            "elapsed": "已用时 {value}",
            "taskDuration": "耗时 {value}",
            "taskSession": "会话 {value}",
            "taskTools": "工具调用 {value}",
            "resultTitle": "返回文本",
            "resultEmpty": "（没有返回文本）",
            "promptRequired": "请先输入任务内容",
            "taskAborted": "已取消（任务可能仍在桥接中继续执行）",
            "taskReturnedError": "任务返回错误：{error}",
            "taskRequestFailed": "任务请求失败：{error}",
            "tasksTitle": "最近任务",
            "tasksEmpty": "还没有任务记录。",
            "tasksCount": "共 {count} 条",
            "refreshTasks": "刷新列表",
            "tasksError": "读取任务失败：{error}",
            "taskNoPrompt": "（无任务描述）",
            "taskOk": "成功",
            "taskFailed": "失败",
            "taskErrorPrefix": "错误：{error}",
            "maintenanceTitle": "维护",
            "maintenanceDesc": "DSH 升级或任务 profile 损坏时，可在这里重建桥接使用的 whale-agent profile。",
            "rebuild": "重建任务 profile",
            "rebuilding": "重建中…",
            "rebuildOk": "已重建任务 profile：{dir}",
            "rebuildCreated": "新建：{value}",
            "rebuildFail": "重建失败：{error}",
            "personaTitle": "人设",
            "personaDesc": "桥接代理在 DSH 原生会话与任务里使用的自定义人设（persona.md）。保存后从下一轮聊天或任务开始生效。",
            "personaPath": "人设文件：{path}",
            "personaPathEmpty": "尚未配置人设文件（桥接设置 personaFile 为空，保存会失败）",
            "personaField": "人设正文",
            "personaHint": "内容会写入桥接的 personaFile（默认在 DSH 状态目录下）；保存后对下一轮聊天或 DSH 任务生效。",
            "personaPlaceholder": "在这里写鲸鱼娘的人设与说话规则…",
            "personaLoad": "重新加载",
            "personaLoading": "读取中…",
            "personaSave": "保存人设",
            "personaSaving": "保存中…",
            "personaSaved": "人设已保存（{count} 字符）",
            "personaSaveFail": "保存人设失败：{error}",
            "personaLoadFail": "读取人设失败：{error}",
            "personaEmpty": "人设文件为空，写入内容后再保存",
            "personaDirty": "有未保存的修改",
            "personaChars": "{count} 字符",
            "personaDiscardConfirm": "有未保存的修改，重新加载会丢弃这些修改，继续吗？",
            "careTitle": "主动搭话",
            "careDesc": "桥接代理按时间窗和频率让鲸鱼娘主动找话说的规则；写回鲸鱼娘 config.json 的 care 段。",
            "careGroupSwitches": "开关与范围",
            "careGroupSwitchesDesc": "总开关和主动搭话的对象范围；默认只找主人、不进群、不找别人。",
            "careEnabled": "启用主动搭话",
            "careEnabledHint": "关掉后她不会主动找你（你找她时的被动回复不受影响）",
            "careOnlyMaster": "只找主人",
            "careOnlyMasterHint": "只主动私聊主人（config.persona.master 里的号）",
            "careAllowGroups": "允许群聊主动搭话",
            "careAllowGroupsHint": "默认只在私聊主动；开启后群聊也可能被她搭话",
            "careAllowOthers": "允许主动私聊他人",
            "careAllowOthersHint": "默认只找主人；开启后其他人的私聊也可能收到主动消息",
            "careGroupFrequency": "频率与上限",
            "careGroupFrequencyDesc": "单位均为分钟；每天到上限后当天不再主动搭话。",
            "careEveryMinutes": "基础间隔（分钟）",
            "careEveryMinutesHint": "两次主动搭话之间的基准间隔",
            "careJitterMinutes": "随机抖动（分钟）",
            "careJitterMinutesHint": "实际间隔 = 基础间隔 + 0~抖动 的随机值",
            "careMaxPerDay": "每天上限（次）",
            "careMaxPerDayHint": "一天最多主动找你几次",
            "careQuietAfterMinutes": "静默判定（分钟）",
            "careQuietAfterMinutesHint": "最近一次互动超过这么久没动静，才考虑主动搭话",
            "careGroupWindows": "允许时段",
            "careGroupWindowsDesc": "逗号分隔的 HH:MM-HH:MM 时间段；留空表示不限时段。",
            "careWindows": "时间段（逗号分隔）",
            "careWindowsHint": "例如 09:00-12:00,14:00-23:00；留空 = 不限时段",
            "careWindowsPlaceholder": "09:00-12:00,14:00-23:00",
            "careReload": "重新加载",
            "careLoading": "读取中…",
            "careSave": "保存设置",
            "careSaving": "保存中…",
            "careSaved": "主动搭话设置已保存",
            "careSaveFail": "保存失败：{error}",
            "careLoadFail": "读取主动搭话设置失败：{error}",
            "careBadNumber": "数字字段需要是非负数字",
            "careBadWindows": "时段格式不对，示例：09:00-12:00,14:00-23:00",
            "careDiscardConfirm": "有未保存的修改，重新加载会丢弃这些修改，继续吗？",
            "booleanYes": "是",
            "booleanNo": "否",
            "none": "无",
            "unknown": "—",
            "requestTimeout": "请求超时（{seconds} 秒）",
            "requestOffline": "无法连接桥接服务：{url}",
            "requestAborted": "请求已取消",
            "requestFailed": "请求失败：{message}",
            "unitMs": "毫秒",
            "unitSeconds": "秒",
            "unitSecondsShort": "秒",
            "unitMinutesShort": "分",
            "unitHoursShort": "时",
            "unitDaysShort": "天"
        };
        // >>>ZH

        // <<<EN
        var EN = {
            "panel": "Whale Bridge",
            "title": "Whale Bridge",
            "intro": "Manage the whale-girl × DeepSeek Harness bridge: check status, tune DSH options, test tasks, and adopt the whale-girl side.",
            "endpoint": "Bridge endpoint: {url}",
            "loading": "Loading…",
            "refresh": "Refresh",
            "refreshing": "Refreshing…",
            "lastUpdated": "Last refresh: {time}",
            "neverUpdated": "Not refreshed yet",
            "statusTitle": "Connection status",
            "bridgeTitle": "Bridge service",
            "whaleTitle": "Whale-girl",
            "dshTitle": "DSH task profile",
            "labelName": "Name",
            "labelVersion": "Version",
            "labelPort": "Port",
            "labelUptime": "Uptime",
            "labelDir": "Directory",
            "labelProfile": "Profile",
            "labelState": "State",
            "labelMode": "Mode",
            "labelProvider": "Provider",
            "labelEndpoint": "Endpoint",
            "labelRunning": "Web page",
            "labelUpstream": "Upstream",
            "stateReady": "Ready",
            "stateMissing": "Not created",
            "stateUnknown": "Unknown",
            "stateOnline": "Online",
            "stateOffline": "Offline",
            "statePartial": "Partial",
            "startChain": "Start full chain",
            "startingChain": "Starting… (up to 90s)",
            "chainTitle": "WeChat chain",
            "chainPlugin": "DSH plugin",
            "chainWhale": "Whale girl",
            "chainBridge": "WeChat bridge",
            "chainAccount": "WeChat account",
            "chainHeartbeat": "Bridge heartbeat",
            "chainFailed": "Start failed: {error}",
            "configuredYes": "Points to the bridge",
            "configuredNo": "Does not point to the bridge",
            "runningYes": "Running",
            "runningNo": "Not running",
            "healthError": "Health check failed: {error}",
            "offlineTitle": "The bridge service is not running",
            "offlineHint": "Enable the Whale Bridge plugin in DSH first (the host side listens on a local port), then press Refresh. If the default port is taken the host starts on the next free port; set that port here and press “Use this port”.",
            "offlineDetail": "Details: {error}",
            "stateFetchError": "Failed to read the bridge state: {error}",
            "statusErrorTitle": "State read failed",
            "optionsTitle": "DSH options",
            "optionsDesc": "Defaults the bridge uses when it runs DSH tasks. Saved values apply to later tasks.",
            "fieldWorkspace": "Workspace",
            "hintWorkspace": "Working directory for DSH child processes; must be an existing absolute path.",
            "placeholderWorkspace": "e.g. D:\\dsh_work",
            "fieldPermission": "Permission",
            "hintPermission": "read-only: no writes; workspace-write: may modify the workspace; danger-full-access: unrestricted.",
            "optReadOnly": "Read-only (read-only)",
            "optWorkspaceWrite": "Workspace writable (workspace-write)",
            "optDanger": "Full access (danger-full-access)",
            "fieldMode": "Mode",
            "hintMode": "standard uses the headless template; creator also enables the plugin-manager tool so tasks can edit DSH plugins.",
            "optStandard": "Standard (standard)",
            "optCreator": "Creator (creator)",
            "fieldTaskModel": "DSH task model",
            "hintTaskModel": "Empty uses the default model (deepseek-flash)",
            "placeholderTaskModel": "e.g. deepseek-flash",
            "fieldReasoningEffort": "Reasoning effort",
            "hintReasoningEffort": "Higher is slower and consumes more reasoning tokens; applies to the next DSH task after saving",
            "optReasoningLow": "Low (low)",
            "optReasoningMedium": "Medium (medium)",
            "optReasoningHigh": "High (high)",
            "optReasoningMax": "Max (max)",
            "mediaCardTitle": "Media & files",
            "mediaCardDesc": "Media cache cleanup and file channel (web attachment upload / download links) settings.",
            "mediaGroupCacheTitle": "Media cache",
            "mediaGroupCacheDesc": "Clean old images, stickers and voice files from data/media-cache on startup/periodically; maps to whale-girl features.mediaCleanup and storage.mediaKeepDays / mediaMaxMB.",
            "mediaCleanup": "Enable media cache cleanup",
            "mediaCleanupHint": "When off the cache is not cleaned automatically (only the size limit applies)",
            "mediaKeepDays": "Retention days",
            "mediaKeepDaysHint": "Cache entries older than this are removed (1-365 days)",
            "mediaMaxMB": "Size limit (MB)",
            "mediaMaxMBHint": "Oldest entries are removed first when the total cache exceeds this limit (10-100000 MB)",
            "mediaReload": "Reload",
            "mediaLoading": "Loading…",
            "mediaSave": "Save media settings",
            "mediaSaving": "Saving…",
            "mediaSaved": "Media cache settings saved",
            "mediaSaveFail": "Saving media settings failed: {error}",
            "mediaLoadFail": "Loading media settings failed: {error}",
            "mediaBadKeepDays": "Retention days must be an integer between 1 and 365",
            "mediaBadMaxMB": "Size limit must be an integer between 10 and 100000 MB",
            "filesGroupTitle": "File channel",
            "filesGroupDesc": "Settings for whale-girl web 📎 uploads and download links; written back to bridge settings.files.",
            "filesEnabled": "Enable file channel",
            "filesEnabledHint": "When off both web uploads and download links are unavailable",
            "filesAutoOutbox": "Auto-collect DSH products",
            "filesAutoOutboxHint": "After a task, new files in the workspace .whale-bridge/outbox become download links automatically",
            "filesMaxFileMB": "Max file size (MB)",
            "filesMaxFileMBHint": "Per-file upload/download size limit (1-500 MB)",
            "filesLinkTtlHours": "Download link TTL (hours)",
            "filesLinkTtlHoursHint": "How long download tokens stay valid (1-720 hours)",
            "filesSave": "Save file settings",
            "filesSaving": "Saving…",
            "filesSaved": "File channel settings saved",
            "filesSaveFail": "Saving file settings failed: {error}",
            "filesBadMaxFileMB": "Max file size must be an integer between 1 and 500 MB",
            "filesBadLinkTtl": "Download link TTL must be an integer between 1 and 720 hours",
            "fieldSession": "Default session ID",
            "hintSession": "Leave empty to start a new session per task; set it to keep context for the same chat.",
            "placeholderSession": "Optional",
            "fieldPort": "Port",
            "hintPort": "Bridge listening port (default 8789). Saving changes it; it takes effect after the plugin restarts. Use “Use this port” to switch this panel immediately.",
            "usePort": "Use this port",
            "save": "Save",
            "saving": "Saving…",
            "saveOk": "Settings saved",
            "saveOkPort": "Settings saved; port changed to {port}, effective after the plugin reloads (then press “Use this port” to switch this panel)",
            "saveFail": "Save failed: {error}",
            "invalidPort": "Invalid port; expected an integer between 1 and 65535",
            "workspaceRequired": "Workspace is required",
            "advancedTitle": "Advanced",
            "advancedDesc": "Upstream OpenAI-compatible service used by the bridge proxy. Leave empty to keep the whale-girl side's own upstream.",
            "fieldUpstreamBaseUrl": "Upstream base URL",
            "hintUpstreamBaseUrl": "OpenAI-compatible baseUrl, e.g. https://api.deepseek.com/v1; empty means no override.",
            "placeholderUpstreamBaseUrl": "https://api.deepseek.com/v1",
            "fieldUpstreamModel": "Upstream model",
            "hintUpstreamModel": "e.g. deepseek-chat; empty means no override.",
            "placeholderUpstreamModel": "deepseek-chat",
            "fieldUpstreamKey": "Upstream key",
            "hintUpstreamKey": "Not echoed after saving; leave empty to keep the configured key.",
            "placeholderKeyConfigured": "Configured; leave empty to keep it",
            "placeholderKeyMissing": "Not configured; enter the upstream API key",
            "keyStatus": "Upstream key: {state}",
            "keyConfigured": "configured",
            "keyMissing": "not configured",
            "saveUpstream": "Save upstream",
            "savingUpstream": "Saving…",
            "upstreamSaveOk": "Upstream settings saved",
            "upstreamSaveFail": "Saving upstream settings failed: {error}",
            "whaleSectionTitle": "Whale-girl integration",
            "whaleSectionDesc": "Point the whale-girl provider at this bridge's OpenAI-compatible proxy, so hands-on chat tasks are handed to DSH.",
            "currentProvider": "Integration",
            "adopt": "Adopt",
            "adopting": "Adopting…",
            "revert": "Revert",
            "reverting": "Reverting…",
            "openWhale": "Open whale-girl web",
            "openDebug": "Open debug page",
            "whaleUrlHint": "Web URL: {url}",
            "adoptOk": "Adopted; changed files: {files}; backup directory: {backup}",
            "adoptFail": "Adopt failed: {error}",
            "revertOk": "Reverted: {files}",
            "revertFail": "Revert failed: {error}",
            "popupBlocked": "The browser blocked the popup; open it manually: {url}",
            "openFail": "Could not open the page: {error}",
            "openingWhale": "Starting whale-girl and opening it… (first start takes a few seconds)",
            "openedWhale": "Opened: {url}",
            "openedWhaleStarted": "whale-girl started and opened: {url}",
            "labelPid": "Process PID",
            "startedByBridge": "started by the bridge",
            "startedByExternal": "started by you",
            "startWhale": "Start whale-girl",
            "stopWhale": "Stop whale-girl",
            "startingWhale": "Starting…",
            "stoppingWhale": "Stopping…",
            "whaleStartOk": "whale-girl started (PID {pid})",
            "whaleAlreadyRunning": "whale-girl is already running; not started again",
            "whaleStopOk": "whale-girl stopped (PID {pid})",
            "whaleStopAlready": "whale-girl was not running",
            "whaleOpFail": "Operation failed: {error}",
            "benchTitle": "Task test bench",
            "benchDesc": "Submit a DSH task through the bridge to verify the DSH side of the link.",
            "benchHint": "Task requests wait up to 10 minutes; status, settings and task-list requests time out after 5 seconds.",
            "promptLabel": "Task content",
            "promptPlaceholder": "e.g. Answer 1+1",
            "run": "Run",
            "runningBtn": "Running…",
            "cancel": "Cancel",
            "elapsed": "Elapsed {value}",
            "taskDuration": "Duration {value}",
            "taskSession": "Session {value}",
            "taskTools": "Tool calls {value}",
            "resultTitle": "Returned text",
            "resultEmpty": "(no text returned)",
            "promptRequired": "Enter a task first",
            "taskAborted": "Cancelled (the task may still be running in the bridge)",
            "taskReturnedError": "Task returned an error: {error}",
            "taskRequestFailed": "Task request failed: {error}",
            "tasksTitle": "Recent tasks",
            "tasksEmpty": "No tasks yet.",
            "tasksCount": "{count} total",
            "refreshTasks": "Refresh list",
            "tasksError": "Failed to read tasks: {error}",
            "taskNoPrompt": "(no task prompt)",
            "taskOk": "OK",
            "taskFailed": "Failed",
            "taskErrorPrefix": "Error: {error}",
            "maintenanceTitle": "Maintenance",
            "maintenanceDesc": "Rebuild the whale-agent profile used by the bridge after a DSH upgrade or profile damage.",
            "rebuild": "Rebuild task profile",
            "rebuilding": "Rebuilding…",
            "rebuildOk": "Task profile rebuilt: {dir}",
            "rebuildCreated": "Created: {value}",
            "rebuildFail": "Rebuild failed: {error}",
            "personaTitle": "Persona",
            "personaDesc": "Custom persona (persona.md) the bridge uses for DSH-native sessions and tasks. Saved text applies from the next chat turn or task.",
            "personaPath": "Persona file: {path}",
            "personaPathEmpty": "No persona file configured (personaFile is empty in bridge settings; saving will fail)",
            "personaField": "Persona text",
            "personaHint": "Written to the bridge personaFile (defaults to the DSH state directory); applies to the next chat turn or DSH task.",
            "personaPlaceholder": "Write the whale-girl persona and speaking rules here…",
            "personaLoad": "Reload",
            "personaLoading": "Loading…",
            "personaSave": "Save persona",
            "personaSaving": "Saving…",
            "personaSaved": "Persona saved ({count} characters)",
            "personaSaveFail": "Saving persona failed: {error}",
            "personaLoadFail": "Loading persona failed: {error}",
            "personaEmpty": "The persona file is empty; write something before saving",
            "personaDirty": "Unsaved changes",
            "personaChars": "{count} characters",
            "personaDiscardConfirm": "There are unsaved changes; reloading discards them. Continue?",
            "careTitle": "Proactive messages",
            "careDesc": "Rules the bridge proxy uses to let whale-girl start conversations by time window and frequency; written back to the care section of whale-girl config.json.",
            "careGroupSwitches": "Switches & scope",
            "careGroupSwitchesDesc": "Master switch and who she may contact; by default only the master, never groups or others.",
            "careEnabled": "Enable proactive messages",
            "careEnabledHint": "When off she will not start conversations (replies to you are unaffected)",
            "careOnlyMaster": "Only message the master",
            "careOnlyMasterHint": "Only DM the master (ids in config.persona.master)",
            "careAllowGroups": "Allow proactive group messages",
            "careAllowGroupsHint": "Off by default (private chats only); when on she may also start group conversations",
            "careAllowOthers": "Allow proactive DMs to others",
            "careAllowOthersHint": "Off by default (master only); when on other private chats may receive proactive messages",
            "careGroupFrequency": "Frequency & limits",
            "careGroupFrequencyDesc": "All values are minutes; once the daily limit is reached she stops for the day.",
            "careEveryMinutes": "Base interval (minutes)",
            "careEveryMinutesHint": "Baseline gap between two proactive messages",
            "careJitterMinutes": "Random jitter (minutes)",
            "careJitterMinutesHint": "Actual gap = base interval + random 0..jitter",
            "careMaxPerDay": "Daily limit (times)",
            "careMaxPerDayHint": "Maximum proactive messages per day",
            "careQuietAfterMinutes": "Quiet threshold (minutes)",
            "careQuietAfterMinutesHint": "Only start a conversation after this long without interaction",
            "careGroupWindows": "Allowed windows",
            "careGroupWindowsDesc": "Comma-separated HH:MM-HH:MM windows; empty means no time restriction.",
            "careWindows": "Time windows (comma separated)",
            "careWindowsHint": "e.g. 09:00-12:00,14:00-23:00; empty = no restriction",
            "careWindowsPlaceholder": "09:00-12:00,14:00-23:00",
            "careReload": "Reload",
            "careLoading": "Loading…",
            "careSave": "Save settings",
            "careSaving": "Saving…",
            "careSaved": "Proactive message settings saved",
            "careSaveFail": "Saving failed: {error}",
            "careLoadFail": "Loading proactive message settings failed: {error}",
            "careBadNumber": "Number fields must be non-negative numbers",
            "careBadWindows": "Invalid time window format, e.g. 09:00-12:00,14:00-23:00",
            "careDiscardConfirm": "There are unsaved changes; reloading discards them. Continue?",
            "booleanYes": "yes",
            "booleanNo": "no",
            "none": "none",
            "unknown": "—",
            "requestTimeout": "Request timed out ({seconds} s)",
            "requestOffline": "Cannot reach the bridge service: {url}",
            "requestAborted": "Request cancelled",
            "requestFailed": "Request failed: {message}",
            "unitMs": "ms",
            "unitSeconds": "s",
            "unitSecondsShort": "s",
            "unitMinutesShort": "m",
            "unitHoursShort": "h",
            "unitDaysShort": "d"
        };
        // >>>EN

        /** apply() 里绑定的翻译函数，供宿主未注入 t 时兜底。 */
        var fallbackT = null;

        /* ================================================================== */
        /* 通用小工具                                                          */
        /* ================================================================== */

        function isObject(value) {
            return value !== null && typeof value === "object";
        }

        function copyObject(source) {
            var target = {};
            if (isObject(source)) {
                for (var key in source) {
                    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
                }
            }
            return target;
        }

        /** 把任意错误载荷转成可读文本，绝不抛异常。 */
        function textOfError(value) {
            if (value === null || value === undefined) return "";
            if (typeof value === "string") return value;
            if (typeof value === "number" || typeof value === "boolean") return String(value);
            if (isObject(value)) {
                if (typeof value.message === "string" && value.message) return value.message;
                if (typeof value.error === "string" && value.error) return value.error;
                try {
                    return JSON.stringify(value);
                } catch (error) {
                    return String(value);
                }
            }
            return String(value);
        }

        function firstString() {
            for (var index = 0; index < arguments.length; index++) {
                var value = arguments[index];
                if (typeof value === "string" && value.length > 0) return value;
            }
            return "";
        }

        function firstNumber() {
            for (var index = 0; index < arguments.length; index++) {
                var value = arguments[index];
                if (typeof value === "number" && isFinite(value)) return value;
            }
            return null;
        }

        function firstValue() {
            for (var index = 0; index < arguments.length; index++) {
                var value = arguments[index];
                if (value !== null && value !== undefined && value !== "") return value;
            }
            return null;
        }

        function substitute(text, params) {
            if (!isObject(params)) return text;
            return String(text).replace(/\{(\w+)\}/g, function (match, name) {
                return Object.prototype.hasOwnProperty.call(params, name) && params[name] !== null && params[name] !== undefined
                    ? String(params[name])
                    : match;
            });
        }

        function makeTranslator(bind) {
            return function translate(key, params) {
                var text = null;
                if (typeof bind === "function") {
                    try {
                        text = bind(key);
                    } catch (error) {
                        text = null;
                    }
                }
                if (typeof text !== "string" || text.length === 0 || text === key) {
                    if (Object.prototype.hasOwnProperty.call(EN, key)) text = EN[key];
                    else if (Object.prototype.hasOwnProperty.call(ZH, key)) text = ZH[key];
                    else text = key;
                }
                return params ? substitute(text, params) : text;
            };
        }

        function useTranslator(props) {
            var bind = props && typeof props.t === "function" ? props.t : fallbackT;
            return makeTranslator(bind);
        }

        function permissionLabel(t, value) {
            if (value === "read-only") return t("optReadOnly");
            if (value === "danger-full-access") return t("optDanger");
            return t("optWorkspaceWrite");
        }

        function modeLabel(t, value) {
            return value === "creator" ? t("optCreator") : t("optStandard");
        }

        function reasoningEffortLabel(t, value) {
            if (value === "low") return t("optReasoningLow");
            if (value === "medium") return t("optReasoningMedium");
            if (value === "high") return t("optReasoningHigh");
            return t("optReasoningMax");
        }

        /** 解析限定范围内的整数（文本输入用；非法/越界返回 { ok:false }）。 */
        function parseIntInRange(value, min, max) {
            var text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
            if (!/^\d+$/.test(text)) return { ok: false, value: null };
            var number = parseInt(text, 10);
            if (!isFinite(number) || number < min || number > max) return { ok: false, value: null };
            return { ok: true, value: number };
        }

        /* ================================================================== */
        /* 端口与请求                                                          */
        /* ================================================================== */

        function isValidPort(value) {
            return typeof value === "number" && isFinite(value) && value >= 1 && value <= 65535 && Math.floor(value) === value;
        }

        function parsePort(value) {
            if (typeof value === "number") return isValidPort(value) ? value : null;
            if (typeof value !== "string") return null;
            var text = value.trim();
            if (!/^\d{1,5}$/.test(text)) return null;
            var number = parseInt(text, 10);
            return isValidPort(number) ? number : null;
        }

        function readStoredPort() {
            try {
                var number = parsePort(window.localStorage.getItem(PORT_STORAGE_KEY));
                if (number !== null) return number;
            } catch (error) {
                /* localStorage 不可用时退回默认端口 */
            }
            return DEFAULT_PORT;
        }

        function writeStoredPort(port) {
            try {
                window.localStorage.setItem(PORT_STORAGE_KEY, String(port));
            } catch (error) {
                /* 忽略存储失败，面板仍可用当前端口 */
            }
        }

        function bridgeUrl(port, path) {
            return BRIDGE_ORIGIN + ":" + port + path;
        }

        /** 带 kind 的 API 错误，保证 UI 能把所有失败转成文字。 */
        function ApiError(kind, message, extra) {
            this.name = "ApiError";
            this.kind = kind;
            this.message = message || kind;
            this.status = extra && extra.status;
            this.url = extra && extra.url;
            this.timeoutMs = extra && extra.timeoutMs;
            this.payload = extra && extra.payload;
            this.cause = extra && extra.cause;
        }
        ApiError.prototype = Object.create(Error.prototype);
        ApiError.prototype.constructor = ApiError;

        function apiMessage(data, status) {
            if (isObject(data)) {
                var detail = textOfError(data.error) || textOfError(data.message) || textOfError(data.detail);
                if (!detail && Array.isArray(data.errors)) {
                    detail = data.errors.map(textOfError).filter(Boolean).join("; ");
                }
                if (detail) return status >= 400 ? "HTTP " + status + ": " + detail : detail;
            }
            return "HTTP " + status;
        }

        /**
         * 向桥接发一个 JSON 请求。
         * @param {number} port - 桥接端口。
         * @param {string} method - HTTP 方法。
         * @param {string} path - 路径。
         * @param {*} body - 可选 JSON body。
         * @param {object} options - timeoutMs / signal / allowOkFalse。
         * @returns {Promise<object>} 解析后的 JSON。
         */
        function request(port, method, path, body, options) {
            options = options || {};
            var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : QUICK_TIMEOUT_MS;
            var externalSignal = options.signal || null;
            var controller = new AbortController();
            var timedOut = false;
            var onExternalAbort = null;
            if (externalSignal) {
                if (externalSignal.aborted) {
                    controller.abort();
                } else {
                    onExternalAbort = function () {
                        controller.abort();
                    };
                    try {
                        externalSignal.addEventListener("abort", onExternalAbort);
                    } catch (error) {
                        /* 忽略 */
                    }
                }
            }
            var timer = setTimeout(function () {
                timedOut = true;
                try {
                    controller.abort();
                } catch (error) {
                    /* 忽略 */
                }
            }, timeoutMs);
            var url = bridgeUrl(port, path);
            var init = {
                method: method,
                signal: controller.signal,
                cache: "no-store",
                headers: { accept: "application/json" }
            };
            if (body !== undefined) {
                init.headers["content-type"] = "application/json";
                init.body = JSON.stringify(body);
            }
            function cleanup() {
                try {
                    clearTimeout(timer);
                } catch (error) {
                    /* 忽略 */
                }
                if (externalSignal && onExternalAbort) {
                    try {
                        externalSignal.removeEventListener("abort", onExternalAbort);
                    } catch (error) {
                        /* 忽略 */
                    }
                }
            }
            function normalizeFailure(error) {
                if (error instanceof ApiError) return error;
                if (error && error.name === "AbortError") {
                    if (externalSignal && externalSignal.aborted) return new ApiError("aborted", "aborted", { url: url });
                    if (timedOut) return new ApiError("timeout", "timeout", { url: url, timeoutMs: timeoutMs });
                    return new ApiError("aborted", "aborted", { url: url });
                }
                return new ApiError("offline", (error && error.message) || "network error", { url: url, cause: error });
            }
            return fetch(url, init)
                .then(function (response) {
                    return response.text().then(function (text) {
                        var data = null;
                        if (text) {
                            try {
                                data = JSON.parse(text);
                            } catch (error) {
                                data = null;
                            }
                        }
                        if (!response.ok) {
                            throw new ApiError("http", apiMessage(data, response.status), {
                                status: response.status,
                                url: url,
                                payload: data
                            });
                        }
                        if (data === null) data = {};
                        if (data.ok === false && options.allowOkFalse !== true) {
                            throw new ApiError("http", apiMessage(data, response.status), {
                                status: response.status,
                                url: url,
                                payload: data
                            });
                        }
                        return data;
                    });
                })
                .then(
                    function (data) {
                        cleanup();
                        return data;
                    },
                    function (error) {
                        cleanup();
                        throw normalizeFailure(error);
                    }
                );
        }

        /**
         * 向桥接自报一个客户端事件（/api/client-report），用于宿主侧可验证性。
         * 2 秒超时，所有失败静默，绝不影响 UI。
         */
        function reportEvent(port, payload) {
            try {
                request(port, "POST", "/api/client-report", payload || {}, { timeoutMs: 2000, allowOkFalse: true }).then(
                    function () {
                        /* 上报成功，无需处理 */
                    },
                    function () {
                        /* 自报失败静默 */
                    }
                );
            } catch (error) {
                /* 自报失败静默 */
            }
        }

        function describeError(t, error) {
            if (!error) return t("unknown");
            if (error.messageKey) return t(error.messageKey);
            if (error.kind === "timeout") {
                var seconds = Math.max(1, Math.round((error.timeoutMs || 0) / 1000));
                return t("requestTimeout", { seconds: seconds });
            }
            if (error.kind === "offline") return t("requestOffline", { url: error.url || "" });
            if (error.kind === "aborted") return t("requestAborted");
            if (error.kind === "http") return error.message || "HTTP " + (error.status || "?");
            if (typeof error.message === "string" && error.message) return t("requestFailed", { message: error.message });
            return t("requestFailed", { message: String(error) });
        }

        /* ================================================================== */
        /* 展示格式化                                                          */
        /* ================================================================== */

        function formatTime(value) {
            if (value === null || value === undefined || value === "") return "";
            try {
                var date = null;
                if (typeof value === "number" && isFinite(value)) {
                    date = new Date(value < 1e12 ? value * 1000 : value);
                } else if (typeof value === "string") {
                    var parsed = Date.parse(value);
                    if (isFinite(parsed)) date = new Date(parsed);
                }
                if (date === null || !isFinite(date.getTime())) return typeof value === "string" ? value : "";
                return date.toLocaleString();
            } catch (error) {
                return typeof value === "string" ? value : "";
            }
        }

        function formatDuration(t, milliseconds) {
            if (typeof milliseconds !== "number" || !isFinite(milliseconds) || milliseconds < 0) return t("unknown");
            if (milliseconds < 1000) return Math.round(milliseconds) + " " + t("unitMs");
            if (milliseconds < 60000) return (milliseconds / 1000).toFixed(1) + " " + t("unitSeconds");
            var totalSeconds = Math.round(milliseconds / 1000);
            var minutes = Math.floor(totalSeconds / 60);
            var seconds = totalSeconds % 60;
            return minutes + " " + t("unitMinutesShort") + " " + seconds + " " + t("unitSecondsShort");
        }

        function formatUptime(t, milliseconds) {
            if (typeof milliseconds !== "number" || !isFinite(milliseconds) || milliseconds < 0) return t("unknown");
            var seconds = Math.floor(milliseconds / 1000);
            if (seconds < 60) return seconds + " " + t("unitSecondsShort");
            var minutes = Math.floor(seconds / 60);
            if (minutes < 60) return minutes + " " + t("unitMinutesShort");
            var hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + " " + t("unitHoursShort") + " " + (minutes % 60) + " " + t("unitMinutesShort");
            return Math.floor(hours / 24) + " " + t("unitDaysShort") + " " + (hours % 24) + " " + t("unitHoursShort");
        }

        function listText(t, list) {
            if (!Array.isArray(list) || list.length === 0) return t("none");
            var parts = [];
            for (var index = 0; index < list.length && index < 8; index++) {
                var item = list[index];
                parts.push(typeof item === "string" ? item : textOfError(item) || "?");
            }
            if (list.length > 8) parts.push("+" + (list.length - 8));
            return parts.join(", ");
        }

        function joinWhaleUrl(base, debug) {
            var fallback = DEFAULT_WHALE_URL + (debug ? "debug" : "");
            try {
                var url = new URL(base);
                if (debug) {
                    var path = url.pathname || "/";
                    if (path.charAt(path.length - 1) !== "/") path += "/";
                    url.pathname = path + "debug";
                    url.search = "";
                    url.hash = "";
                }
                return url.href;
            } catch (error) {
                return fallback;
            }
        }

        /* ================================================================== */
        /* settings / state 投影                                               */
        /* ================================================================== */

        function emptyForm(currentPort) {
            return {
                workspace: "",
                permission: "workspace-write",
                mode: "standard",
                model: "",
                reasoningEffort: "max",
                defaultSessionId: "",
                port: String(currentPort),
                upstreamBaseUrl: "",
                upstreamModel: "",
                upstreamKey: ""
            };
        }

        function readUpstream(settings) {
            var upstream = settings && isObject(settings.upstream) ? settings.upstream : null;
            if (!upstream) return { baseUrl: "", model: "", apiKey: "", hasKey: false };
            var apiKey = typeof upstream.apiKey === "string" ? upstream.apiKey : "";
            return {
                baseUrl: typeof upstream.baseUrl === "string" ? upstream.baseUrl : "",
                model: typeof upstream.model === "string" ? upstream.model : "",
                apiKey: apiKey,
                hasKey: apiKey.length > 0 || upstream.hasKey === true
            };
        }

        function formFromSettings(settings, currentPort) {
            var source = isObject(settings) ? settings : {};
            var upstream = readUpstream(source);
            return {
                workspace: typeof source.workspace === "string" ? source.workspace : "",
                permission: PERMISSIONS.indexOf(source.permission) >= 0 ? source.permission : "workspace-write",
                mode: MODES.indexOf(source.mode) >= 0 ? source.mode : "standard",
                model: typeof source.model === "string" ? source.model : "",
                reasoningEffort: REASONING_EFFORTS.indexOf(source.reasoningEffort) >= 0 ? source.reasoningEffort : "max",
                defaultSessionId: typeof source.defaultSessionId === "string" ? source.defaultSessionId : "",
                port: isValidPort(source.port) ? String(source.port) : String(currentPort),
                upstreamBaseUrl: upstream.baseUrl,
                upstreamModel: upstream.model,
                upstreamKey: ""
            };
        }

        function mergeDshForm(previous, settings, currentPort) {
            var fresh = formFromSettings(settings, currentPort);
            var next = copyObject(previous);
            next.workspace = fresh.workspace;
            next.permission = fresh.permission;
            next.mode = fresh.mode;
            next.model = fresh.model;
            next.reasoningEffort = fresh.reasoningEffort;
            next.defaultSessionId = fresh.defaultSessionId;
            next.port = fresh.port;
            return next;
        }

        function mergeUpstreamForm(previous, settings) {
            var upstream = readUpstream(settings);
            var next = copyObject(previous);
            next.upstreamBaseUrl = upstream.baseUrl;
            next.upstreamModel = upstream.model;
            next.upstreamKey = "";
            return next;
        }

        /**
         * 读取 DSH 任务 profile 状态。
         * 兼容宿主两种形状：status.dsh 直接带字段，或嵌套在 status.dsh.profile 里。
         */
        function readProfileStatus(status) {
            if (status === null || status === undefined) return null;
            if (typeof status === "string") return { dir: status, ready: null, name: "", version: "", mode: "", error: "" };
            if (!isObject(status)) return null;
            var profile = isObject(status.profile) ? status.profile : null;
            var source = profile || status;
            var ready = null;
            var booleanKeys = ["ready", "exists", "profileExists", "created", "ok"];
            for (var index = 0; index < booleanKeys.length; index++) {
                if (typeof source[booleanKeys[index]] === "boolean") {
                    ready = source[booleanKeys[index]];
                    break;
                }
            }
            return {
                dir: firstString(source.dir, source.profileDir, source.path, typeof source.profile === "string" ? source.profile : ""),
                ready: ready,
                name: firstString(source.name),
                version: firstString(status.version, source.version),
                mode: firstString(source.mode, status.mode),
                error: textOfError(source.error) || textOfError(status.error)
            };
        }

        function normalizeTasks(t, items) {
            var rows = [];
            if (!Array.isArray(items)) return rows;
            var limit = items.length < 20 ? items.length : 20;
            for (var index = 0; index < limit; index++) {
                var item = items[index];
                var row = {
                    key: index,
                    prompt: t("taskNoPrompt"),
                    timeText: "",
                    durationMs: null,
                    sessionId: "",
                    toolCalls: null,
                    errorText: "",
                    ok: true
                };
                if (typeof item === "string") {
                    row.prompt = item || t("taskNoPrompt");
                } else if (isObject(item)) {
                    row.prompt = firstString(item.prompt, item.instruction, item.task, item.title, item.summary) || t("taskNoPrompt");
                    row.timeText = formatTime(firstValue(item.finishedAt, item.completedAt, item.endedAt, item.startedAt, item.createdAt, item.at, item.time, item.timestamp));
                    row.durationMs = firstNumber(item.durationMs, item.duration, item.elapsedMs, item.elapsed);
                    row.sessionId = firstString(item.sessionId, item.session);
                    row.toolCalls = firstNumber(item.toolCalls);
                    if (row.toolCalls === null && Array.isArray(item.tools)) row.toolCalls = item.tools.length;
                    row.errorText = textOfError(item.error);
                    row.ok = item.ok !== false && row.errorText.length === 0;
                } else {
                    row.prompt = String(item);
                }
                rows.push(row);
            }
            return rows;
        }

        /* ================================================================== */
        /* 文案组装                                                            */
        /* ================================================================== */

        function saveMessage(t, result) {
            if (!result) return "";
            var text;
            if (result.kind === "ok") {
                text = result.portChanged ? t("saveOkPort", { port: result.portChanged }) : t("saveOk");
            } else {
                text = t("saveFail", { error: describeError(t, result.error) });
            }
            if (Array.isArray(result.warnings) && result.warnings.length > 0) text += "\n" + result.warnings.join("\n");
            return text;
        }

        function upstreamMessage(t, result) {
            if (!result) return "";
            if (result.kind === "ok") return t("upstreamSaveOk");
            return t("upstreamSaveFail", { error: describeError(t, result.error) });
        }

        function whaleMessage(t, result) {
            if (!result) return "";
            if (result.kind === "adoptOk") {
                var text = t("adoptOk", { files: listText(t, result.files), backup: result.backupDir || t("none") });
                if (result.warning) text += "\n" + result.warning;
                return text;
            }
            if (result.kind === "revertOk") return t("revertOk", { files: listText(t, result.restored) });
            if (result.kind === "adoptFail") return t("adoptFail", { error: describeError(t, result.error) });
            if (result.kind === "revertFail") return t("revertFail", { error: describeError(t, result.error) });
            if (result.kind === "popupBlocked") return t("popupBlocked", { url: result.url || "" });
            if (result.kind === "openFail") return t("openFail", { error: describeError(t, result.error) });
            if (result.kind === "opening") return t("openingWhale", { url: result.url || "" });
            if (result.kind === "openedStarted") return t("openedWhaleStarted", { url: result.url || "" });
            if (result.kind === "opened") return t("openedWhale", { url: result.url || "" });
            if (result.kind === "whaleStarted") return t("whaleStartOk", { pid: result.pid || "?" });
            if (result.kind === "whaleAlreadyRunning") return t("whaleAlreadyRunning");
            if (result.kind === "whaleStopped") return t("whaleStopOk", { pid: result.pid || "?" });
            if (result.kind === "whaleStopAlready") return t("whaleStopAlready");
            if (result.kind === "whaleFail") return t("whaleOpFail", { error: describeError(t, result.error) });
            return "";
        }

        function whaleMessageKind(result) {
            if (!result) return "info";
            if (result.kind === "opening") return "info";
            return result.kind === "adoptFail" || result.kind === "revertFail" || result.kind === "openFail" || result.kind === "popupBlocked" || result.kind === "whaleFail"
                ? "error"
                : "ok";
        }

        function rebuildMessage(t, result) {
            if (!result) return "";
            if (result.kind === "ok") {
                var text = t("rebuildOk", { dir: result.profileDir || t("unknown") });
                if (result.created !== null) text += " " + t("rebuildCreated", { value: result.created ? t("booleanYes") : t("booleanNo") });
                return text;
            }
            return t("rebuildFail", { error: describeError(t, result.error) });
        }

        /* ================================================================== */
        /* 纯展示组件                                                          */
        /* ================================================================== */

        function button(options, children) {
            var props = { type: "button", className: "wbBtn", "data-variant": options.variant || "secondary" };
            if (options.onClick) props.onClick = options.onClick;
            if (options.disabled) props.disabled = true;
            if (options.title) props.title = options.title;
            return h("button", props, children);
        }

        function message(kind, text) {
            if (!text) return null;
            return h("p", { className: "wbMessage", "data-kind": kind }, text);
        }

        function cardHead(title, description) {
            return h(
                "div",
                { className: "wbCardHead" },
                h("div", null, h("h2", { className: "wbCardTitle" }, title), description ? h("p", { className: "wbCardDesc" }, description) : null)
            );
        }

        function infoLine(key, label, value, mono) {
            var text = value === null || value === undefined || value === "" ? "—" : value;
            return h(
                "div",
                { key: key, className: "wbInfoLine" },
                h("span", { className: "wbInfoKey" }, label),
                h("span", { className: mono ? "wbInfoValue wbMono" : "wbInfoValue", title: String(text) }, text)
            );
        }

        function statusCard(title, state, lines) {
            return h(
                "div",
                { className: "wbStatusCard" },
                h("div", { className: "wbStatusHead" }, h("span", { className: "wbDot", "data-state": state }), h("span", { className: "wbStatusTitle" }, title)),
                h("div", { className: "wbStatusBody" }, lines)
            );
        }

        /**
         * 表单字段。
         * @param {string} label - 字段名。
         * @param {*} control - 输入控件。
         * @param {string} hint - 可选说明。
         * @param {object} options - 可选：{ full: true } 让字段在 .wbForm 网格里独占一行。
         */
        function field(label, control, hint, options) {
            var className = options && options.full ? "wbField wbFieldFull" : "wbField";
            return h(
                "label",
                { className: className },
                h("span", { className: "wbLabel" }, label),
                control,
                hint ? h("span", { className: "wbHint" }, hint) : null
            );
        }

        /**
         * 卡片内的语义分组：标题 + 说明 + 内容，和上下分组之间用分隔线隔开。
         * 只影响展示，不携带任何请求逻辑；子节点按位置传入（可变参数，避免 React key 警告）。
         */
        function group(title, description) {
            var head = null;
            if (title || description) {
                head = h(
                    "div",
                    { className: "wbGroupHead" },
                    h(
                        "div",
                        null,
                        title ? h("h3", { className: "wbGroupTitle" }, title) : null,
                        description ? h("p", { className: "wbGroupDesc" }, description) : null
                    )
                );
            }
            var children = ["div", { className: "wbGroup" }, head];
            for (var index = 2; index < arguments.length; index++) children.push(arguments[index]);
            return h.apply(null, children);
        }

        /**
         * 复选开关字段（放在 .wbChecks 网格里；label + 说明）。
         */
        function checkField(label, checked, onChange, hint) {
            return h(
                "label",
                { className: "wbCheckField" },
                h("input", {
                    type: "checkbox",
                    checked: Boolean(checked),
                    onChange: function (event) {
                        onChange(Boolean(event.target.checked));
                    }
                }),
                h(
                    "span",
                    { className: "wbCheckText" },
                    h("span", { className: "wbCheckLabel" }, label),
                    hint ? h("span", { className: "wbHint" }, hint) : null
                )
            );
        }

        function taskResultView(t, result, elapsedMs) {
            if (!result) return null;
            if (result.kind === "running") {
                return h("p", { className: "wbMessage", "data-kind": "info" }, t("elapsed", { value: formatDuration(t, elapsedMs) }));
            }
            if (result.kind === "ok") {
                return h(
                    "div",
                    { className: "wbResult" },
                    h(
                        "div",
                        { className: "wbResultMeta" },
                        h("span", { className: "wbTaskStatus", "data-state": "ok" }, t("taskOk")),
                        result.sessionId ? h("span", null, t("taskSession", { value: result.sessionId })) : null,
                        typeof result.durationMs === "number" ? h("span", null, t("taskDuration", { value: formatDuration(t, result.durationMs) })) : null,
                        typeof result.toolCalls === "number" ? h("span", null, t("taskTools", { value: result.toolCalls })) : null
                    ),
                    h("span", { className: "wbResultLabel" }, t("resultTitle")),
                    h("pre", { className: "wbPre" }, result.text && result.text.length > 0 ? result.text : t("resultEmpty"))
                );
            }
            if (result.kind === "aborted") {
                return h("p", { className: "wbMessage", "data-kind": "info" }, t("taskAborted"));
            }
            if (result.kind === "failed") {
                return h("p", { className: "wbMessage", "data-kind": "error" }, t("taskReturnedError", { error: result.errorText || t("taskFailed") }));
            }
            return h("p", { className: "wbMessage", "data-kind": "error" }, t("taskRequestFailed", { error: describeError(t, result.error) }));
        }

        /* ================================================================== */
        /* 图标（sidebar.panellist 传入 { size, active }）                      */
        /* ================================================================== */

        function WhaleBridgeIcon(props) {
            var size = props && typeof props.size === "number" ? props.size : 18;
            return h(
                "svg",
                {
                    className: "wbIcon",
                    width: size,
                    height: size,
                    viewBox: "0 0 24 24",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 1.6,
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                    "aria-hidden": "true",
                    focusable: "false"
                },
                h("path", { key: "deck", d: "M2.5 9h19" }),
                h("path", { key: "arch", d: "M4 9C4 6 7.6 4 12 4s8 2 8 5" }),
                h("path", {
                    key: "body",
                    d: "M3.8 15.9c0-2 1.8-3.6 4.3-3.6h4.3c2.4 0 4.3 1.5 4.3 3.2 0 2-1.9 3.4-4.3 3.4H8.1c-2.5 0-4.3-1.4-4.3-3Z"
                }),
                h("path", { key: "tail", d: "M16.8 15.8l2.8-1.7v4.4l-2.8-1.7Z" }),
                h("path", { key: "spout", d: "M9.1 12c0-.9.3-1.6.9-2.1" }),
                h("circle", { key: "eye", cx: 7, cy: 15.7, r: 0.7, fill: "currentColor", stroke: "none" })
            );
        }

        /* ================================================================== */
        /* 主面板                                                              */
        /* ================================================================== */

        function WhaleBridgePanel(props) {
            var t = useTranslator(props);

            var portPair = useState(readStoredPort);
            var port = portPair[0];
            var setPort = portPair[1];
            var portRef = useRef(port);
            var aliveRef = useRef(true);
            var genRef = useRef(0);
            var inFlightRef = useRef(false);

            var healthPair = useState(null);
            var health = healthPair[0];
            var setHealth = healthPair[1];
            var healthErrorPair = useState(null);
            var healthError = healthErrorPair[0];
            var setHealthError = healthErrorPair[1];

            var serverStatePair = useState(null);
            var serverState = serverStatePair[0];
            var setServerState = serverStatePair[1];
            var stateErrorPair = useState(null);
            var stateError = stateErrorPair[0];
            var setStateError = stateErrorPair[1];

            var connectionPair = useState("unknown");
            var connection = connectionPair[0];
            var setConnection = connectionPair[1];
            var chainStartingPair = useState(false);
            var chainStarting = chainStartingPair[0];
            var setChainStarting = chainStartingPair[1];
            var chainErrorPair = useState(null);
            var chainError = chainErrorPair[0];
            var setChainError = chainErrorPair[1];
            var refreshingPair = useState(false);
            var refreshing = refreshingPair[0];
            var setRefreshing = refreshingPair[1];
            var updatedPair = useState(null);
            var updatedAt = updatedPair[0];
            var setUpdatedAt = updatedPair[1];

            var formPair = useState(function () {
                return emptyForm(portRef.current);
            });
            var form = formPair[0];
            var setForm = formPair[1];
            var dshDirtyRef = useRef(false);
            var upstreamDirtyRef = useRef(false);

            var savingPair = useState(false);
            var saving = savingPair[0];
            var setSaving = savingPair[1];
            var saveResultPair = useState(null);
            var saveResult = saveResultPair[0];
            var setSaveResult = saveResultPair[1];

            var upstreamSavingPair = useState(false);
            var upstreamSaving = upstreamSavingPair[0];
            var setUpstreamSaving = upstreamSavingPair[1];
            var upstreamResultPair = useState(null);
            var upstreamResult = upstreamResultPair[0];
            var setUpstreamResult = upstreamResultPair[1];

            var whaleOpPair = useState(null);
            var whaleOp = whaleOpPair[0];
            var setWhaleOp = whaleOpPair[1];
            var whaleResultPair = useState(null);
            var whaleResult = whaleResultPair[0];
            var setWhaleResult = whaleResultPair[1];
            var whaleProcPair = useState(null);
            var whaleProcBusy = whaleProcPair[0];
            var setWhaleProcBusy = whaleProcPair[1];

            var rebuildingPair = useState(false);
            var rebuilding = rebuildingPair[0];
            var setRebuilding = rebuildingPair[1];
            var rebuildResultPair = useState(null);
            var rebuildResult = rebuildResultPair[0];
            var setRebuildResult = rebuildResultPair[1];

            /* ---- DSH 原生聊天（新鲸鱼娘）面板状态 ---- */
            var nativePair = useState({ brain: null, sessions: [], busy: false, msg: "", reply: "", testText: "", testBusy: false });
            var native = nativePair[0];
            var setNative = nativePair[1];
            function updateNative(patch) {
                setNative(function (prev) {
                    return Object.assign({}, prev, patch);
                });
            }
            var loadNative = useCallback(function () {
                return request(portRef.current, "GET", "/api/brain", undefined, { timeoutMs: QUICK_TIMEOUT_MS })
                    .then(function (data) {
                        updateNative({ brain: data.brain, sessions: data.sessions || [] });
                    })
                    .catch(function () { return undefined; });
            }, []);
            useEffect(function () {
                loadNative();
                return undefined;
            }, []);
            function sendNative() {
                var text = String((native && native.testText) || "").trim();
                if (!text || native.testBusy) return;
                updateNative({ testBusy: true, reply: "" });
                request(
                    portRef.current,
                    "POST",
                    "/api/brain/chat",
                    { text: text, chatKey: "panel|u|test" },
                    { timeoutMs: 900000 }
                )
                    .then(function (r) {
                        updateNative({ testBusy: false, reply: r.reply || r.error || "" });
                        loadNative();
                    })
                    .catch(function (e) {
                        updateNative({ testBusy: false, reply: "请求失败：" + describeError(t, e) });
                    });
            }

            /* ---- 人设（桥接 persona.md：GET /api/persona、PUT /api/persona）---- */
            var personaPair = useState({
                loaded: false,
                busy: true,
                saving: false,
                dirty: false,
                path: "",
                text: "",
                msg: "",
                msgKind: "info"
            });
            var persona = personaPair[0];
            var setPersona = personaPair[1];
            function updatePersona(patch) {
                setPersona(function (prev) {
                    return Object.assign({}, prev, patch);
                });
            }
            var loadPersona = useCallback(function () {
                return request(portRef.current, "GET", "/api/persona", undefined, { timeoutMs: QUICK_TIMEOUT_MS })
                    .then(function (data) {
                        var text = data && typeof data.text === "string" ? data.text : "";
                        updatePersona({
                            loaded: true,
                            busy: false,
                            dirty: false,
                            path: data && typeof data.path === "string" ? data.path : "",
                            text: text,
                            msg: "",
                            msgKind: "info"
                        });
                        return text;
                    })
                    .catch(function (e) {
                        updatePersona({
                            loaded: true,
                            busy: false,
                            msg: t("personaLoadFail", { error: describeError(t, e) }),
                            msgKind: "error"
                        });
                        return "";
                    });
            }, []);
            useEffect(function () {
                loadPersona();
                return undefined;
            }, []);
            function reloadPersona() {
                if (persona.busy || persona.saving) return;
                if (persona.dirty) {
                    var proceed = true;
                    try {
                        proceed = window.confirm(t("personaDiscardConfirm"));
                    } catch (e) {
                        proceed = true;
                    }
                    if (!proceed) return;
                }
                updatePersona({ busy: true, msg: "", msgKind: "info" });
                loadPersona();
            }
            function changePersonaText(value) {
                updatePersona({ text: value, dirty: true });
            }
            function savePersona() {
                if (persona.saving || persona.busy) return;
                var text = typeof persona.text === "string" ? persona.text : "";
                if (text.trim() === "") {
                    updatePersona({ msg: t("personaEmpty"), msgKind: "error" });
                    return;
                }
                updatePersona({ saving: true, msg: "", msgKind: "info" });
                request(portRef.current, "PUT", "/api/persona", { text: text }, { timeoutMs: QUICK_TIMEOUT_MS }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        var savedPath = isObject(data) && typeof data.path === "string" && data.path ? data.path : persona.path;
                        updatePersona({
                            saving: false,
                            dirty: false,
                            path: savedPath,
                            msg: t("personaSaved", { count: text.length }),
                            msgKind: "ok"
                        });
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        updatePersona({
                            saving: false,
                            msg: t("personaSaveFail", { error: describeError(t, error) }),
                            msgKind: "error"
                        });
                    }
                );
            }

            /* ---- 主动搭话（care.*：GET/POST /api/whale/console/care）---- */
            var carePair = useState({
                loaded: false,
                busy: true,
                saving: false,
                dirty: false,
                enabled: true,
                onlyMaster: true,
                allowGroups: false,
                allowOthers: false,
                everyMinutes: "90",
                jitterMinutes: "25",
                maxPerDay: "6",
                quietAfterMinutes: "20",
                windows: "09:00-12:00, 14:00-23:00",
                msg: "",
                msgKind: "info"
            });
            var care = carePair[0];
            var setCare = carePair[1];
            function updateCare(patch) {
                setCare(function (prev) {
                    return Object.assign({}, prev, patch);
                });
            }
            function numberText(value) {
                return typeof value === "number" && isFinite(value) ? String(value) : "";
            }
            var loadCare = useCallback(function (keepMessage) {
                return request(portRef.current, "GET", "/api/whale/console/care", undefined, { timeoutMs: QUICK_TIMEOUT_MS })
                    .then(function (data) {
                        var src = isObject(data) && isObject(data.care) ? data.care : {};
                        var patch = {
                            loaded: true,
                            busy: false,
                            dirty: false,
                            enabled: src.enabled !== false,
                            onlyMaster: src.onlyMaster !== false,
                            allowGroups: src.allowGroups === true,
                            allowOthers: src.allowOthers === true,
                            everyMinutes: numberText(src.everyMinutes),
                            jitterMinutes: numberText(src.jitterMinutes),
                            maxPerDay: numberText(src.maxPerDay),
                            quietAfterMinutes: numberText(src.quietAfterMinutes),
                            windows: Array.isArray(src.windows) ? src.windows.join(", ") : ""
                        };
                        if (!keepMessage) {
                            patch.msg = "";
                            patch.msgKind = "info";
                        }
                        updateCare(patch);
                        return src;
                    })
                    .catch(function (e) {
                        updateCare({
                            loaded: true,
                            busy: false,
                            msg: t("careLoadFail", { error: describeError(t, e) }),
                            msgKind: "error"
                        });
                        return null;
                    });
            }, []);
            useEffect(function () {
                loadCare(false);
                return undefined;
            }, []);
            function changeCare(patch) {
                updateCare(Object.assign({ dirty: true }, patch));
            }
            function reloadCare() {
                if (care.busy || care.saving) return;
                if (care.dirty) {
                    var proceed = true;
                    try {
                        proceed = window.confirm(t("careDiscardConfirm"));
                    } catch (e) {
                        proceed = true;
                    }
                    if (!proceed) return;
                }
                updateCare({ busy: true, msg: "", msgKind: "info" });
                loadCare(false);
            }
            function careNumber(value) {
                var text = typeof value === "string" ? value.trim() : "";
                if (text === "") return { ok: true, value: null };
                var number = Number(text);
                if (!isFinite(number) || number < 0) return { ok: false, value: null };
                return { ok: true, value: number };
            }
            function careWindowsList(value) {
                var text = typeof value === "string" ? value.trim() : "";
                if (!text) return [];
                return text
                    .split(/[,，;；\s]+/)
                    .map(function (part) {
                        return part.trim();
                    })
                    .filter(Boolean);
            }
            function saveCare() {
                if (care.saving || care.busy) return;
                var fields = [
                    ["everyMinutes", care.everyMinutes],
                    ["jitterMinutes", care.jitterMinutes],
                    ["maxPerDay", care.maxPerDay],
                    ["quietAfterMinutes", care.quietAfterMinutes]
                ];
                var bodyCare = {
                    enabled: Boolean(care.enabled),
                    onlyMaster: Boolean(care.onlyMaster),
                    allowGroups: Boolean(care.allowGroups),
                    allowOthers: Boolean(care.allowOthers)
                };
                for (var index = 0; index < fields.length; index++) {
                    var parsed = careNumber(fields[index][1]);
                    if (!parsed.ok) {
                        updateCare({ msg: t("careBadNumber"), msgKind: "error" });
                        return;
                    }
                    if (parsed.value !== null) bodyCare[fields[index][0]] = parsed.value;
                }
                var windows = careWindowsList(care.windows);
                for (var wi = 0; wi < windows.length; wi++) {
                    if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(windows[wi])) {
                        updateCare({ msg: t("careBadWindows"), msgKind: "error" });
                        return;
                    }
                }
                bodyCare.windows = windows;
                updateCare({ saving: true, msg: "", msgKind: "info" });
                request(portRef.current, "POST", "/api/whale/console/care", { care: bodyCare }, { timeoutMs: QUICK_TIMEOUT_MS }).then(
                    function () {
                        if (!aliveRef.current) return;
                        updateCare({ saving: false, dirty: false, msg: t("careSaved"), msgKind: "ok" });
                        loadCare(true);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        updateCare({
                            saving: false,
                            msg: t("careSaveFail", { error: describeError(t, error) }),
                            msgKind: "error"
                        });
                    }
                );
            }

            /* ---- 媒体缓存（GET/POST /api/whale/console/media）---- */
            var mediaPair = useState({
                loaded: false,
                busy: true,
                saving: false,
                cleanup: true,
                keepDays: "7",
                maxMB: "500",
                msg: "",
                msgKind: "info"
            });
            var media = mediaPair[0];
            var setMedia = mediaPair[1];
            function updateMedia(patch) {
                setMedia(function (prev) {
                    return Object.assign({}, prev, patch);
                });
            }
            var loadMedia = useCallback(function (keepMessage) {
                return request(portRef.current, "GET", "/api/whale/console/media", undefined, { timeoutMs: QUICK_TIMEOUT_MS })
                    .then(function (data) {
                        var src = isObject(data) && isObject(data.media) ? data.media : {};
                        var patch = {
                            loaded: true,
                            busy: false,
                            cleanup: src.cleanup !== false,
                            keepDays: numberText(src.keepDays) || "7",
                            maxMB: numberText(src.maxMB) || "500"
                        };
                        if (!keepMessage) {
                            patch.msg = "";
                            patch.msgKind = "info";
                        }
                        updateMedia(patch);
                        return src;
                    })
                    .catch(function (e) {
                        updateMedia({
                            loaded: true,
                            busy: false,
                            msg: t("mediaLoadFail", { error: describeError(t, e) }),
                            msgKind: "error"
                        });
                        return null;
                    });
            }, []);
            useEffect(function () {
                loadMedia(false);
                return undefined;
            }, []);
            function reloadMedia() {
                if (media.busy || media.saving) return;
                updateMedia({ busy: true, msg: "", msgKind: "info" });
                loadMedia(false);
            }
            function saveMedia() {
                if (media.saving || media.busy) return;
                var keepDays = parseIntInRange(media.keepDays, 1, 365);
                if (!keepDays.ok) {
                    updateMedia({ msg: t("mediaBadKeepDays"), msgKind: "error" });
                    return;
                }
                var maxMB = parseIntInRange(media.maxMB, 10, 100000);
                if (!maxMB.ok) {
                    updateMedia({ msg: t("mediaBadMaxMB"), msgKind: "error" });
                    return;
                }
                updateMedia({ saving: true, msg: "", msgKind: "info" });
                request(
                    portRef.current,
                    "POST",
                    "/api/whale/console/media",
                    { media: { cleanup: Boolean(media.cleanup), keepDays: keepDays.value, maxMB: maxMB.value } },
                    { timeoutMs: QUICK_TIMEOUT_MS }
                ).then(
                    function () {
                        if (!aliveRef.current) return;
                        updateMedia({ saving: false, msg: t("mediaSaved"), msgKind: "ok" });
                        loadMedia(true);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        updateMedia({
                            saving: false,
                            msg: t("mediaSaveFail", { error: describeError(t, error) }),
                            msgKind: "error"
                        });
                    }
                );
            }

            /* ---- 文件通道（settings.files；走 PUT /api/settings，只发 files 字段）---- */
            var filesDirtyRef = useRef(false);
            var filesPair = useState({
                loaded: false,
                saving: false,
                enabled: true,
                autoOutbox: true,
                maxFileMB: "20",
                linkTtlHours: "24",
                msg: "",
                msgKind: "info"
            });
            var files = filesPair[0];
            var setFiles = filesPair[1];
            function updateFiles(patch) {
                setFiles(function (prev) {
                    return Object.assign({}, prev, patch);
                });
            }
            function filesFromSettings(settingsValue) {
                var source = isObject(settingsValue) && isObject(settingsValue.files) ? settingsValue.files : {};
                return {
                    loaded: true,
                    enabled: source.enabled !== false,
                    autoOutbox: source.autoOutbox !== false,
                    maxFileMB: numberText(source.maxFileMB) || "20",
                    linkTtlHours: numberText(source.linkTtlHours) || "24"
                };
            }
            useEffect(
                function () {
                    if (!isObject(serverState) || !isObject(serverState.settings)) return;
                    if (!isObject(serverState.settings.files)) return;
                    setFiles(function (prev) {
                        if (filesDirtyRef.current) return prev;
                        return Object.assign({}, prev, filesFromSettings(serverState.settings));
                    });
                },
                [serverState]
            );
            function changeFiles(patch) {
                filesDirtyRef.current = true;
                updateFiles(Object.assign({ msg: "", msgKind: "info" }, patch));
            }
            function saveFiles() {
                if (files.saving) return;
                var maxFileMB = parseIntInRange(files.maxFileMB, 1, 500);
                if (!maxFileMB.ok) {
                    updateFiles({ msg: t("filesBadMaxFileMB"), msgKind: "error" });
                    return;
                }
                var linkTtlHours = parseIntInRange(files.linkTtlHours, 1, 720);
                if (!linkTtlHours.ok) {
                    updateFiles({ msg: t("filesBadLinkTtl"), msgKind: "error" });
                    return;
                }
                updateFiles({ saving: true, msg: "", msgKind: "info" });
                request(
                    portRef.current,
                    "PUT",
                    "/api/settings",
                    {
                        files: {
                            enabled: Boolean(files.enabled),
                            autoOutbox: Boolean(files.autoOutbox),
                            maxFileMB: maxFileMB.value,
                            linkTtlHours: linkTtlHours.value
                        }
                    },
                    { timeoutMs: QUICK_TIMEOUT_MS }
                ).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        filesDirtyRef.current = false;
                        var patch = { saving: false, msg: t("filesSaved"), msgKind: "ok" };
                        if (isObject(data) && isObject(data.settings) && isObject(data.settings.files)) {
                            Object.assign(patch, filesFromSettings(data.settings));
                        }
                        updateFiles(patch);
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        updateFiles({
                            saving: false,
                            msg: t("filesSaveFail", { error: describeError(t, error) }),
                            msgKind: "error"
                        });
                    }
                );
            }

            /* ---- 鲸鱼娘调试台（从网页 /debug 搬进面板）---- */
            var wcPair = useState({
                loaded: false,
                busy: false,
                msg: "",
                status: null,
                memory: null,
                persona: null,
                mapping: null,
                sessions: [],
                features: null,
                accounts: [],
                accountChoice: "",
                visionSample: "",
                memBackupMsg: "",
                cfgBaseUrl: "",
                cfgModel: "",
                resetKey: "",
                promptText: "",
                promptSystem: ""
            });
            var wc = wcPair[0];
            var setWc = wcPair[1];
            function updateWc(patch) {
                setWc(function (prev) {
                    return Object.assign({}, prev, patch);
                });
            }
            var loadConsole = useCallback(function () {
                updateWc({ busy: true });
                return request(portRef.current, "GET", "/api/whale/console", undefined, { timeoutMs: 30000 })
                    .then(function (data) {
                        var map = data.mapping || null;
                        updateWc({
                            busy: false,
                            loaded: true,
                            status: (data.whale && data.whale.status) || null,
                            memory: (data.whale && data.whale.memory) || null,
                            persona: (data.whale && data.whale.persona) || null,
                            features: (data.whale && data.whale.features) || null,
                            sessions: (data.whale && data.whale.sessions && data.whale.sessions.sessions) || [],
                            mapping: map,
                            cfgBaseUrl: map ? (map.whaleBaseUrl || "") : "",
                            cfgModel: map ? (map.whaleModel || "") : ""
                        });
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, msg: "调试台加载失败：" + describeError(t, e) });
                    });
            }, []);
            useEffect(function () {
                loadConsole();
                return undefined;
            }, []);
            function toggleFeature(feature) {
                var next = !(feature.enabled || feature.value);
                updateWc({ busy: true, msg: "切换功能开关：" + (feature.label || feature.key) + " → " + (next ? "开" : "关") });
                request(
                    portRef.current,
                    "POST",
                    "/api/whale/console/feature",
                    { key: feature.key, value: next },
                    { timeoutMs: 15000 }
                )
                    .then(function (r) {
                        updateWc({ busy: false, msg: r.ok ? "已切换 " + (feature.label || feature.key) : "切换失败：" + (r.error || "") });
                        loadConsole();
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, msg: "切换失败：" + describeError(t, e) });
                    });
            }
            function loadAccounts() {
                return request(portRef.current, "GET", "/api/whale/console/accounts", undefined, { timeoutMs: 20000 })
                    .then(function (data) {
                        var list = (data && data.accounts) || [];
                        var selected = "";
                        for (var i = 0; i < list.length; i += 1) {
                            if (list[i] && list[i].selected) selected = String(list[i].account || "");
                        }
                        updateWc({ accounts: list, accountChoice: (wc && wc.accountChoice) || selected });
                    })
                    .catch(function () { return undefined; });
            }
            useEffect(function () {
                loadAccounts();
                return undefined;
            }, []);
            function applyAccount() {
                var account = String((wc && wc.accountChoice) || "").trim();
                updateWc({ busy: true, msg: account ? "切换微信账号：" + account : "设为自动选账号" });
                request(portRef.current, "POST", "/api/whale/console/account", { account: account }, { timeoutMs: 20000 })
                    .then(function (r) {
                        updateWc({ busy: false, msg: r.ok ? "已设置" + (account ? "：" + account : "：自动（按最近活跃）") + (r.needBridgeRestart ? "；桥接会在几秒内自动重启" : "") : "设置失败：" + (r.error || "") });
                        loadConsole();
                        loadAccounts();
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, msg: "设置失败：" + describeError(t, e) });
                    });
            }
            function refreshAccounts() {
                updateWc({ busy: true, msg: "扫描微信账号中（最多 30s）…" });
                request(portRef.current, "POST", "/api/whale/console/accounts/refresh", {}, { timeoutMs: 60000 })
                    .then(function (data) {
                        var list = (data && data.accounts) || [];
                        updateWc({ busy: false, msg: "扫描完成：" + list.length + " 个账号", accounts: list });
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, msg: "扫描失败：" + describeError(t, e) });
                    });
            }
            function testVision() {
                updateWc({ busy: true, visionSample: "测试中…" });
                request(portRef.current, "POST", "/api/whale/console/vision-test", {}, { timeoutMs: 60000 })
                    .then(function (r) {
                        updateWc({ busy: false, visionSample: r.ok ? ("看图返回：" + (r.sample || "（空）")) : ("看图失败：" + (r.error || "")) });
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, visionSample: "看图请求失败：" + describeError(t, e) });
                    });
            }
            function backupMemory() {
                updateWc({ busy: true, memBackupMsg: "备份中…" });
                request(portRef.current, "POST", "/api/whale/console/memory/backup", {}, { timeoutMs: 30000 })
                    .then(function (r) {
                        updateWc({ busy: false, memBackupMsg: r.ok ? ("已生成记忆快照：" + (r.file || r.message || "")) : ("备份失败：" + (r.error || "")) });
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, memBackupMsg: "备份失败：" + describeError(t, e) });
                    });
            }
            function saveWhaleConfig() {
                updateWc({ busy: true, msg: "保存中…" });
                request(
                    portRef.current,
                    "POST",
                    "/api/whale/console/config",
                    { patch: { provider: "custom", llm: { baseUrl: wc.cfgBaseUrl, model: wc.cfgModel } } },
                    { timeoutMs: 30000 }
                )
                    .then(function (r) {
                        updateWc({ busy: false, msg: r.ok ? "鲸鱼娘 LLM 映射已保存" : "保存失败：" + (r.error || "") });
                        loadConsole();
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, msg: "保存失败：" + describeError(t, e) });
                    });
            }
            function resetWhaleMemory() {
                var key = String((wc && wc.resetKey) || "").trim();
                if (!key) {
                    updateWc({ msg: "先填要清空的会话 key（可从上面或 /debug 会话列表里抄）" });
                    return;
                }
                updateWc({ busy: true, msg: "清空中…" });
                request(
                    portRef.current,
                    "POST",
                    "/api/whale/console/memory/reset",
                    { key: key },
                    { timeoutMs: 15000 }
                )
                    .then(function () {
                        updateWc({ busy: false, msg: "已清空会话记忆：" + key, resetKey: "" });
                        loadConsole();
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, msg: "清空失败：" + describeError(t, e) });
                    });
            }
            function sendWhalePrompt() {
                var text = String((wc && wc.promptText) || "").trim();
                if (!text || wc.busy) return;
                updateWc({ busy: true, promptSystem: "" });
                request(
                    portRef.current,
                    "POST",
                    "/api/whale/console/prompt",
                    { text: text },
                    { timeoutMs: 30000 }
                )
                    .then(function (r) {
                        updateWc({
                            busy: false,
                            promptSystem: r.system || r.error || "（没有返回 system 预览）"
                        });
                    })
                    .catch(function (e) {
                        updateWc({ busy: false, promptSystem: "请求失败：" + describeError(t, e) });
                    });
            }

            var promptPair = useState("");
            var prompt = promptPair[0];
            var setPrompt = promptPair[1];
            var runningPair = useState(false);
            var running = runningPair[0];
            var setRunning = runningPair[1];
            var startedPair = useState(null);
            var startedAt = startedPair[0];
            var setStartedAt = startedPair[1];
            var elapsedPair = useState(0);
            var elapsedMs = elapsedPair[0];
            var setElapsedMs = elapsedPair[1];
            var taskResultPair = useState(null);
            var taskResult = taskResultPair[0];
            var setTaskResult = taskResultPair[1];
            var taskAbortRef = useRef(null);
            var taskStartRef = useRef(0);

            var tasksPair = useState([]);
            var tasks = tasksPair[0];
            var setTasks = tasksPair[1];
            var tasksErrorPair = useState(null);
            var tasksError = tasksErrorPair[0];
            var setTasksError = tasksErrorPair[1];
            var tasksLoadingPair = useState(false);
            var tasksLoading = tasksLoadingPair[0];
            var setTasksLoading = tasksLoadingPair[1];

            /** 面板首次挂载自报（仅一次）。 */
            var reportedRef = useRef(false);

            useEffect(function () {
                if (reportedRef.current) return undefined;
                reportedRef.current = true;
                reportEvent(portRef.current, { event: "panel-mounted", panelId: PANEL_ID });
                return undefined;
            }, []);

            /* ---------------- 刷新与轮询 ---------------- */

            var refresh = useCallback(function (manual) {
                if (inFlightRef.current) return Promise.resolve();
                inFlightRef.current = true;
                if (manual) setRefreshing(true);
                var generation = genRef.current;
                var target = portRef.current;
                function isCurrent() {
                    return aliveRef.current && generation === genRef.current;
                }
                function wrap(promise) {
                    return promise.then(
                        function (data) {
                            return { ok: true, data: data };
                        },
                        function (error) {
                            return { ok: false, error: error };
                        }
                    );
                }
                return Promise.all([
                    wrap(request(target, "GET", "/api/health", undefined, { timeoutMs: QUICK_TIMEOUT_MS })),
                    wrap(request(target, "GET", "/api/state", undefined, { timeoutMs: QUICK_TIMEOUT_MS }))
                ])
                    .then(function (results) {
                        inFlightRef.current = false;
                        if (!isCurrent()) return;
                        var healthResult = results[0];
                        var stateResult = results[1];
                        var anyOk = false;
                        var chain = null;
                        if (healthResult.ok) {
                            setHealth(isObject(healthResult.data) ? healthResult.data : {});
                            setHealthError(null);
                            anyOk = true;
                        } else {
                            setHealth(null);
                            setHealthError(healthResult.error);
                        }
                        if (stateResult.ok) {
                            var data = isObject(stateResult.data) ? stateResult.data : {};
                            setServerState(data);
                            setStateError(null);
                            setTasks(Array.isArray(data.tasks) ? data.tasks : []);
                            setUpdatedAt(Date.now());
                            var _st = isObject(data.status) ? data.status : null;
            chain = isObject(_st) && isObject(_st.chain) ? _st.chain : null;
                            anyOk = true;
                        } else {
                            setStateError(stateResult.error);
                        }
                        if (!anyOk) {
                            setConnection("offline");
                        } else if (chain && chain.online === true) {
                            setConnection("online");
                        } else {
                            setConnection("partial");
                        }
                    })
                    .catch(function (error) {
                        inFlightRef.current = false;
                        if (!isCurrent()) return;
                        setConnection("offline");
                        setStateError(error);
                    })
                    .then(function () {
                        if (isCurrent()) setRefreshing(false);
                    });
            }, []);

            useEffect(
                function () {
                    aliveRef.current = true;
                    genRef.current += 1;
                    inFlightRef.current = false;
                    refresh(false);
                    var timer = window.setInterval(function () {
                        refresh(false);
                    }, POLL_INTERVAL_MS);
                    return function () {
                        aliveRef.current = false;
                        genRef.current += 1;
                        window.clearInterval(timer);
                    };
                },
                [refresh, port]
            );

            /* ---------------- 表单与服务端同步 ---------------- */

            useEffect(
                function () {
                    if (!isObject(serverState) || !isObject(serverState.settings)) return;
                    var settings = serverState.settings;
                    setForm(function (previous) {
                        var next = previous;
                        if (!dshDirtyRef.current) next = mergeDshForm(next, settings, portRef.current);
                        if (!upstreamDirtyRef.current) next = mergeUpstreamForm(next, settings);
                        return next;
                    });
                },
                [serverState]
            );

            useEffect(
                function () {
                    if (!running || startedAt === null) return undefined;
                    var timer = window.setInterval(function () {
                        if (aliveRef.current) setElapsedMs(Date.now() - startedAt);
                    }, 200);
                    return function () {
                        window.clearInterval(timer);
                    };
                },
                [running, startedAt]
            );

            /* ---------------- 端口 ---------------- */

            function commitPort(next) {
                if (!isValidPort(next)) return false;
                var changed = portRef.current !== next;
                portRef.current = next;
                writeStoredPort(next);
                setPort(next);
                return changed;
            }

            function useDraftPort() {
                var next = parsePort(form.port);
                if (next === null) {
                    setSaveResult({ kind: "error", error: { messageKey: "invalidPort" } });
                    return;
                }
                setSaveResult(null);
                if (next === portRef.current) {
                    refresh(true);
                    return;
                }
                commitPort(next);
            }

            /* ---------------- 表单编辑 ---------------- */

            function updateDshForm(key, value) {
                dshDirtyRef.current = true;
                setForm(function (previous) {
                    var next = copyObject(previous);
                    next[key] = value;
                    return next;
                });
                if (saveResult) setSaveResult(null);
            }

            function updateUpstreamForm(key, value) {
                upstreamDirtyRef.current = true;
                setForm(function (previous) {
                    var next = copyObject(previous);
                    next[key] = value;
                    return next;
                });
                if (upstreamResult) setUpstreamResult(null);
            }

            /* ---------------- 保存 DSH 选项 ---------------- */

            function saveSettings() {
                if (saving) return;
                var workspace = typeof form.workspace === "string" ? form.workspace.trim() : "";
                if (workspace === "") {
                    setSaveResult({ kind: "error", error: { messageKey: "workspaceRequired" } });
                    return;
                }
                var nextPort = parsePort(form.port);
                if (nextPort === null) {
                    setSaveResult({ kind: "error", error: { messageKey: "invalidPort" } });
                    return;
                }
                var body = {
                    workspace: workspace,
                    permission: form.permission,
                    mode: form.mode,
                    model: typeof form.model === "string" ? form.model.trim() : "",
                    reasoningEffort: REASONING_EFFORTS.indexOf(form.reasoningEffort) >= 0 ? form.reasoningEffort : "max",
                    defaultSessionId: typeof form.defaultSessionId === "string" ? form.defaultSessionId.trim() : "",
                    port: nextPort
                };
                setSaving(true);
                setSaveResult(null);
                request(portRef.current, "PUT", "/api/settings", body, { timeoutMs: QUICK_TIMEOUT_MS }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        setSaving(false);
                        dshDirtyRef.current = false;
                        var saved = isObject(data) && isObject(data.settings) ? data.settings : null;
                        var targetPort = nextPort;
                        setForm(function (previous) {
                            return mergeDshForm(previous, saved || { workspace: workspace, permission: body.permission, mode: body.mode, model: body.model, reasoningEffort: body.reasoningEffort, defaultSessionId: body.defaultSessionId, port: nextPort }, targetPort);
                        });
                        /* 宿主只在插件重载后才监听新端口：不自动切换本面板连接目标，避免立刻失联。 */
                        var knownPort = settings && isValidPort(settings.port) ? settings.port : portRef.current;
                        var portChanged = nextPort !== knownPort;
                        var warnings = isObject(data) && Array.isArray(data.warnings)
                            ? data.warnings.map(textOfError).filter(function (line) { return Boolean(line); })
                            : [];
                        setSaveResult({ kind: "ok", portChanged: portChanged ? nextPort : null, warnings: warnings });
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setSaving(false);
                        setSaveResult({ kind: "error", error: error });
                    }
                );
            }

            /* ---------------- 保存上游（高级） ---------------- */

            function saveUpstream() {
                if (upstreamSaving) return;
                var current = isObject(serverState) && isObject(serverState.settings) ? readUpstream(serverState.settings) : readUpstream(null);
                var typedKey = typeof form.upstreamKey === "string" ? form.upstreamKey.trim() : "";
                var body = {
                    upstream: {
                        baseUrl: typeof form.upstreamBaseUrl === "string" ? form.upstreamBaseUrl.trim() : "",
                        apiKey: typedKey !== "" ? typedKey : current.apiKey,
                        model: typeof form.upstreamModel === "string" ? form.upstreamModel.trim() : ""
                    }
                };
                setUpstreamSaving(true);
                setUpstreamResult(null);
                request(portRef.current, "PUT", "/api/settings", body, { timeoutMs: QUICK_TIMEOUT_MS }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        setUpstreamSaving(false);
                        upstreamDirtyRef.current = false;
                        var saved = isObject(data) && isObject(data.settings) ? data.settings : null;
                        setForm(function (previous) {
                            var next = mergeUpstreamForm(previous, saved || body);
                            next.upstreamKey = "";
                            return next;
                        });
                        setUpstreamResult({ kind: "ok" });
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setUpstreamSaving(false);
                        setUpstreamResult({ kind: "error", error: error });
                    }
                );
            }

            /* ---------------- 鲸鱼娘接入 / 还原 ---------------- */

            function runWhaleOp(op) {
                if (whaleOp !== null) return;
                setWhaleOp(op);
                setWhaleResult(null);
                var path = op === "adopt" ? "/api/whale/adopt" : "/api/whale/revert";
                request(portRef.current, "POST", path, {}, { timeoutMs: QUICK_TIMEOUT_MS }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        setWhaleOp(null);
                        if (op === "adopt") {
                            setWhaleResult({
                                kind: "adoptOk",
                                files: Array.isArray(data.files) ? data.files : [],
                                backupDir: typeof data.backupDir === "string" ? data.backupDir : "",
                                warning: typeof data.warning === "string" ? data.warning : ""
                            });
                        } else {
                            setWhaleResult({ kind: "revertOk", restored: Array.isArray(data.restored) ? data.restored : [] });
                        }
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setWhaleOp(null);
                        setWhaleResult({ kind: op === "adopt" ? "adoptFail" : "revertFail", error: error });
                    }
                );
            }

            function openWhalePage(which) {
                var url = which === "debug" ? currentWhaleDebug() : currentWhaleBase();
                // 由宿主先确保鲸鱼娘已启动，再用系统浏览器打开目标页（不受浏览器弹窗拦截影响）
                setWhaleResult({ kind: "opening", url: url });
                request(portRef.current, "POST", "/api/whale/open", { target: which }, { timeoutMs: 120000 }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        if (!data || data.ok === false) {
                            setWhaleResult({ kind: "openFail", error: (data && data.error) || t("unknown") });
                            return;
                        }
                        setWhaleResult({ kind: data.started ? "openedStarted" : "opened", url: data.url || url });
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setWhaleResult({ kind: "openFail", error: error });
                    }
                );
            }

            /* ---------------- 启动 / 停止鲸鱼娘 ---------------- */

            function controlWhale(action) {
                if (whaleProcBusy !== null) return;
                setWhaleProcBusy(action);
                setWhaleResult(null);
                var isStart = action === "start";
                var path = isStart ? "/api/whale/start" : "/api/whale/stop";
                request(portRef.current, "POST", path, {}, { timeoutMs: isStart ? 150000 : 30000 }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        setWhaleProcBusy(null);
                        if (!data || data.ok === false) {
                            setWhaleResult({ kind: "whaleFail", error: (data && data.error) || t("unknown") });
                            return;
                        }
                        if (isStart) {
                            setWhaleResult({
                                kind: data.alreadyRunning ? "whaleAlreadyRunning" : "whaleStarted",
                                pid: typeof data.pid === "number" ? data.pid : null,
                            });
                        } else {
                            setWhaleResult({
                                kind: data.alreadyStopped ? "whaleStopAlready" : "whaleStopped",
                                pid: typeof data.stoppedPid === "number" ? data.stoppedPid : null,
                                startedBy: typeof data.startedBy === "string" ? data.startedBy : "",
                            });
                        }
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setWhaleProcBusy(null);
                        setWhaleResult({ kind: "whaleFail", error: error });
                    }
                );
            }

            /* ---------------- 重建任务 profile ---------------- */

            function rebuildProfile() {
                if (rebuilding) return;
                setRebuilding(true);
                setRebuildResult(null);
                request(portRef.current, "POST", "/api/dsh/rebuild-profile", {}, { timeoutMs: REBUILD_TIMEOUT_MS }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        setRebuilding(false);
                        setRebuildResult({
                            kind: "ok",
                            profileDir: isObject(data) && typeof data.profileDir === "string" ? data.profileDir : "",
                            created: isObject(data) && typeof data.created === "boolean" ? data.created : null
                        });
                        refresh(false);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setRebuilding(false);
                        setRebuildResult({ kind: "error", error: error });
                    }
                );
            }

            /* ---------------- 任务测试台 ---------------- */

            function runTask() {
                if (running) return;
                var text = typeof prompt === "string" ? prompt.trim() : "";
                if (text === "") {
                    setTaskResult({ kind: "failed", errorText: t("promptRequired") });
                    return;
                }
                var controller = new AbortController();
                taskAbortRef.current = controller;
                taskStartRef.current = Date.now();
                setRunning(true);
                setStartedAt(taskStartRef.current);
                setElapsedMs(0);
                setTaskResult({ kind: "running" });
                request(portRef.current, "POST", "/api/task", { prompt: text, timeoutMs: TASK_TIMEOUT_MS }, {
                    timeoutMs: TASK_TIMEOUT_MS,
                    signal: controller.signal,
                    allowOkFalse: true
                }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        taskAbortRef.current = null;
                        setRunning(false);
                        var duration = firstNumber(isObject(data) ? data.durationMs : null);
                        if (duration === null) duration = Date.now() - taskStartRef.current;
                        if (isObject(data) && data.ok === false) {
                            setTaskResult({
                                kind: "failed",
                                errorText: textOfError(data.error) || t("taskFailed"),
                                sessionId: firstString(data.sessionId),
                                durationMs: duration
                            });
                        } else {
                            var toolCalls = null;
                            if (isObject(data)) {
                                toolCalls = firstNumber(data.toolCalls);
                                if (toolCalls === null && Array.isArray(data.toolCalls)) toolCalls = data.toolCalls.length;
                            }
                            setTaskResult({
                                kind: "ok",
                                text: isObject(data) && typeof data.text === "string" ? data.text : "",
                                sessionId: isObject(data) ? firstString(data.sessionId) : "",
                                durationMs: duration,
                                toolCalls: toolCalls
                            });
                        }
                        refreshTaskList();
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        taskAbortRef.current = null;
                        setRunning(false);
                        var duration = Date.now() - taskStartRef.current;
                        if (error && error.kind === "aborted") setTaskResult({ kind: "aborted", durationMs: duration });
                        else setTaskResult({ kind: "error", error: error, durationMs: duration });
                    }
                );
            }

            function cancelTask() {
                var controller = taskAbortRef.current;
                if (!controller) return;
                try {
                    controller.abort();
                } catch (error) {
                    /* 忽略 */
                }
            }

            function refreshTaskList() {
                if (tasksLoading) return;
                setTasksLoading(true);
                request(portRef.current, "GET", "/api/tasks", undefined, { timeoutMs: QUICK_TIMEOUT_MS }).then(
                    function (data) {
                        if (!aliveRef.current) return;
                        setTasksLoading(false);
                        setTasks(isObject(data) && Array.isArray(data.tasks) ? data.tasks : []);
                        setTasksError(null);
                    },
                    function (error) {
                        if (!aliveRef.current) return;
                        setTasksLoading(false);
                        setTasksError(error);
                    }
                );
            }

            /* ---------------- 派生展示数据 ---------------- */

            var settings = isObject(serverState) && isObject(serverState.settings) ? serverState.settings : null;
            var upstream = readUpstream(settings);
            var whaleStatus = isObject(serverState) && isObject(serverState.status) && isObject(serverState.status.whale) ? serverState.status.whale : null;
            var profileStatus = isObject(serverState) && isObject(serverState.status) ? readProfileStatus(serverState.status.dsh) : null;
            var whaleBase = whaleStatus && typeof whaleStatus.url === "string" && whaleStatus.url ? whaleStatus.url : DEFAULT_WHALE_URL;
            var configured =
                whaleStatus === null
                    ? null
                    : whaleStatus.configured === true ||
                      (typeof whaleStatus.baseUrl === "string" && whaleStatus.baseUrl.length > 0) ||
                      (typeof whaleStatus.provider === "string" && whaleStatus.provider.toLowerCase() === "custom");
            var whaleRunning = whaleStatus !== null && typeof whaleStatus.running === "boolean" ? whaleStatus.running : null;
            var hasStoredKey = upstream.hasKey;
            var offline = connection === "offline";
            var chain = isObject(serverState) && isObject(serverState.status) && isObject(serverState.status.chain)
                ? serverState.status.chain
                : null;
            var chainOnline = Boolean(chain && chain.online === true);

            function startChain() {
                if (chainStarting) return;
                setChainStarting(true);
                setChainError(null);
                request(portRef.current, "POST", "/api/chain/start", {}, { timeoutMs: 130000 })
                    .then(function (data) {
                        if (data && data.ok) {
                            setChainError(null);
                        } else {
                            setChainError((data && data.error) || "chain not online");
                        }
                        return refresh(true);
                    })
                    .catch(function (error) {
                        setChainError(error);
                    })
                    .then(function () {
                        setChainStarting(false);
                    });
            }

            function currentWhaleBase() {
                return whaleBase;
            }

            function currentWhaleDebug() {
                if (whaleStatus && typeof whaleStatus.debugUrl === "string" && whaleStatus.debugUrl) return whaleStatus.debugUrl;
                return joinWhaleUrl(currentWhaleBase(), true);
            }

            var chainLines = [];
            if (chain) {
                chainLines.push(infoLine("plugin", t("chainPlugin"), chain.plugin ? t("stateOnline") : t("stateOffline"), true));
                chainLines.push(infoLine("whale", t("chainWhale"),
                    chain.whale && chain.whale.running ? t("runningYes") : t("runningNo"), true));
                chainLines.push(infoLine("wechat-bridge", t("chainBridge"),
                    chain.bridge && chain.bridge.online ? t("stateOnline") : t("stateOffline"), true));
                var cw = chain.wechat || null;
                if (cw && (cw.accountNick || cw.account)) {
                    chainLines.push(infoLine("account", t("chainAccount"), (cw.accountNick || cw.account) + (cw.accountOk === false ? "（账号不匹配）" : ""), true));
                }
                if (cw && typeof cw.lastSeenSec === "number") {
                    chainLines.push(infoLine("heartbeat", t("chainHeartbeat"), String(cw.lastSeenSec) + "s", true));
                }
            } else {
                chainLines.push(h("p", { key: "loading", className: "wbMuted" }, t("loading")));
            }
            if (chainError) chainLines.push(message("error", t("chainFailed", { error: describeError(t, chainError) })));

            var bridgeLines = [];
            if (health) {
                if (health.version) bridgeLines.push(infoLine("version", t("labelVersion"), String(health.version)));
                bridgeLines.push(infoLine("port", t("labelPort"), String(typeof health.port === "number" ? health.port : port), true));
                if (typeof health.uptimeMs === "number") bridgeLines.push(infoLine("uptime", t("labelUptime"), formatUptime(t, health.uptimeMs)));
                if (health.name) bridgeLines.push(infoLine("name", t("labelName"), String(health.name)));
            } else if (healthError) {
                bridgeLines.push(message("error", t("healthError", { error: describeError(t, healthError) })));
            } else {
                bridgeLines.push(h("p", { key: "loading", className: "wbMuted" }, t("loading")));
            }

            var whaleLines = [];
            if (whaleStatus) {
                whaleLines.push(
                    h(
                        "div",
                        { key: "badges", className: "wbRow" },
                        h(
                            "span",
                            { className: "wbBadge", "data-state": configured ? "ok" : "warn" },
                            t("currentProvider") + "：" + (configured ? t("configuredYes") : t("configuredNo"))
                        ),
                        h(
                            "span",
                            {
                                className: "wbBadge",
                                "data-state": whaleRunning === true ? "ok" : whaleRunning === false ? "warn" : "unknown"
                            },
                            t("labelRunning") + "：" + (whaleRunning === true ? t("runningYes") : whaleRunning === false ? t("runningNo") : t("stateUnknown"))
                        )
                    )
                );
                if (typeof whaleStatus.pid === "number" && whaleStatus.pid > 0) {
                    var by = whaleStatus.startedBy === "bridge" ? t("startedByBridge") : whaleStatus.startedBy === "external" ? t("startedByExternal") : "";
                    whaleLines.push(infoLine("pid", t("labelPid"), String(whaleStatus.pid) + (by ? " · " + by : "")));
                }
                if (typeof whaleStatus.provider === "string" && whaleStatus.provider) {
                    whaleLines.push(infoLine("provider", t("labelProvider"), whaleStatus.provider));
                }
                if (typeof whaleStatus.baseUrl === "string" && whaleStatus.baseUrl) {
                    whaleLines.push(infoLine("baseUrl", t("labelEndpoint"), whaleStatus.baseUrl, true));
                }
                if (typeof whaleStatus.dir === "string" && whaleStatus.dir) {
                    whaleLines.push(infoLine("dir", t("labelDir"), whaleStatus.dir, true));
                }
                if (typeof whaleStatus.version === "string" || typeof whaleStatus.version === "number") {
                    whaleLines.push(infoLine("version", t("labelVersion"), String(whaleStatus.version)));
                }
            } else if (offline) {
                whaleLines.push(h("p", { key: "offline", className: "wbMuted" }, t("stateUnknown")));
            } else {
                whaleLines.push(h("p", { key: "loading", className: "wbMuted" }, t("loading")));
            }

            var dshLines = [];
            if (profileStatus) {
                var profileState = profileStatus.ready === true ? "ok" : profileStatus.ready === false ? "warn" : "unknown";
                dshLines.push(
                    h(
                        "div",
                        { key: "state", className: "wbRow" },
                        h(
                            "span",
                            { className: "wbBadge", "data-state": profileState },
                            t("labelState") + "：" + (profileStatus.ready === true ? t("stateReady") : profileStatus.ready === false ? t("stateMissing") : t("stateUnknown"))
                        )
                    )
                );
                if (profileStatus.name) dshLines.push(infoLine("name", t("labelName"), profileStatus.name, true));
                if (profileStatus.dir) dshLines.push(infoLine("dir", t("labelProfile"), profileStatus.dir, true));
                if (profileStatus.version) dshLines.push(infoLine("version", t("labelVersion"), "DSH " + profileStatus.version));
                if (settings && MODES.indexOf(settings.mode) >= 0) {
                    dshLines.push(infoLine("settingMode", t("labelMode"), modeLabel(t, settings.mode)));
                } else if (profileStatus.mode) {
                    dshLines.push(infoLine("mode", t("labelMode"), modeLabel(t, profileStatus.mode)));
                }
                if (profileStatus.error) dshLines.push(message("error", profileStatus.error));
            } else if (offline) {
                dshLines.push(h("p", { key: "offline", className: "wbMuted" }, t("stateUnknown")));
            } else {
                dshLines.push(h("p", { key: "loading", className: "wbMuted" }, t("loading")));
            }

            var taskRows = normalizeTasks(t, tasks);

            /* ---------------- 渲染 ---------------- */

            return h(
                "div",
                { className: "wbPage" },
                h(
                    "header",
                    { className: "wbHead" },
                    h(
                        "div",
                        null,
                        h("h1", { className: "wbTitle" }, t("title")),
                        h("p", { className: "wbIntro" }, t("intro")),
                        h("p", { className: "wbEndpoint wbMono" }, t("endpoint", { url: bridgeUrl(port, "") }))
                    ),
                    h(
                        "div",
                        { className: "wbHeadActions" },
                        h(
                            "span",
                            { className: "wbBadge", "data-state": connection === "online" ? "ok" : connection === "offline" ? "error" : "warn" },
                            connection === "online" ? t("stateOnline") : connection === "offline" ? t("stateOffline") : t("statePartial")
                        ),
                        h("span", { className: "wbUpdated" }, updatedAt ? t("lastUpdated", { time: formatTime(updatedAt) }) : t("neverUpdated")),
                        button({ variant: "primary", disabled: refreshing || chainStarting, onClick: startChain }, chainStarting ? t("startingChain") : t("startChain")),
                        button({ variant: "primary", disabled: refreshing || chainStarting, onClick: function () { refresh(true); } }, refreshing ? t("refreshing") : t("refresh"))
                    )
                ),
                offline
                    ? h(
                          "div",
                          { className: "wbBanner", "data-kind": "error" },
                          h("p", { className: "wbBannerTitle" }, t("offlineTitle")),
                          h("p", { className: "wbBannerText" }, t("offlineHint")),
                          stateError || healthError
                              ? h("p", { className: "wbBannerText wbMono" }, t("offlineDetail", { error: describeError(t, stateError || healthError) }))
                              : null,
                          h("p", { className: "wbBannerText wbMono" }, t("endpoint", { url: bridgeUrl(port, "") }))
                      )
                    : null,
                !offline && stateError
                    ? h(
                          "div",
                          { className: "wbBanner", "data-kind": "warn" },
                          h("p", { className: "wbBannerTitle" }, t("statusErrorTitle")),
                          h("p", { className: "wbBannerText" }, t("stateFetchError", { error: describeError(t, stateError) }))
                      )
                    : null,
                h(
                    "section",
                    { className: "wbCard", "data-kind": "native" },
                    cardHead(
                        "DSH 原生（新鲸鱼娘）",
                        "第一手聊天直接交给 DSH 会话：每个聊天固定一个 DSH 会话；发「新会话」可重开。这里也管鲸鱼娘↔DSH 的映射同步。"
                    ),
                    group(
                        "聊天大脑",
                        "dsh = 不再调上游模型，回复由 DSH 会话生成；upstream = 原来的代理模式。改完点「保存大脑设置」才写入桥接。",
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                "聊天大脑",
                                h(
                                    "select",
                                    {
                                        className: "wbSelect",
                                        value: native.brain || "upstream",
                                        onChange: function (event) {
                                            updateNative({ brain: event.target.value });
                                        }
                                    },
                                    h("option", { value: "upstream" }, "上游模型（旧模式）"),
                                    h("option", { value: "dsh" }, "DSH 原生（推荐）")
                                ),
                                "保存后影响下一条聊天；面板内的原生测试不受影响。"
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button(
                                    {
                                        variant: "primary",
                                        disabled: native.busy,
                                        onClick: function () {
                                            updateNative({ busy: true, msg: "保存中…" });
                                            request(
                                                portRef.current,
                                                "PUT",
                                                "/api/brain",
                                                { brain: native.brain },
                                                { timeoutMs: QUICK_TIMEOUT_MS }
                                            )
                                                .then(function (r) {
                                                    updateNative({ busy: false, msg: "已保存：brain=" + (r.brain || native.brain) });
                                                })
                                                .catch(function (e) {
                                                    updateNative({ busy: false, msg: "保存失败：" + describeError(t, e) });
                                                });
                                        }
                                    },
                                    "保存大脑设置"
                                )
                            )
                        ),
                        native.msg ? h("p", { className: "wbMessage", "data-kind": "info" }, native.msg) : null
                    ),
                    group(
                        "原生聊天测试",
                        "不经过鲸鱼娘，直接验证 DSH 能否正常回话（固定 chatKey=panel|u|test）。",
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                "发送给 DSH",
                                h("input", {
                                    className: "wbInput",
                                    type: "text",
                                    value: native.testText || "",
                                    placeholder: "输入一句话，直接发给 DSH 原生会话（chatKey=panel|u|test）",
                                    spellCheck: false,
                                    autoComplete: "off",
                                    onChange: function (event) {
                                        updateNative({ testText: event.target.value });
                                    },
                                    onKeyDown: function (event) {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            sendNative();
                                        }
                                    }
                                }),
                                "回车或点「发送给 DSH」发送。"
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ variant: "primary", disabled: native.testBusy, onClick: sendNative }, native.testBusy ? "DSH 思考中…" : "发送给 DSH")
                            )
                        ),
                        native.reply
                            ? h(
                                  "div",
                                  { className: "wbReply" },
                                  h("p", { className: "wbMuted" }, "DSH 回复："),
                                  h("p", null, native.reply)
                              )
                            : null
                    ),
                    group(
                        "会话映射",
                        "「鲸鱼娘聊天 → DSH 会话」的映射。重置只清映射，不删 DSH 会话里的内容。",
                        h(
                            "div",
                            { className: "wbForm" },
                            h(
                                "div",
                                { className: "wbActions" },
                                button(
                                    {
                                        onClick: function () {
                                            updateNative({ busy: true, msg: "同步中…" });
                                            request(portRef.current, "POST", "/api/brain/sync", {}, { timeoutMs: 30000 })
                                                .then(function () {
                                                    updateNative({ busy: false, msg: "已同步鲸鱼娘映射（provider → DSH 插件）" });
                                                    loadNative();
                                                })
                                                .catch(function (e) {
                                                    updateNative({ busy: false, msg: "同步失败：" + describeError(t, e) });
                                                });
                                        }
                                    },
                                    "同步链路映射"
                                ),
                                button(
                                    {
                                        onClick: function () {
                                            request(portRef.current, "POST", "/api/brain/reset", {}, { timeoutMs: QUICK_TIMEOUT_MS })
                                                .then(function () {
                                                    updateNative({ msg: "已清空所有聊天→DSH 会话映射" });
                                                    loadNative();
                                                })
                                                .catch(function () { return undefined; });
                                        }
                                    },
                                    "重置全部会话"
                                )
                            )
                        ),
                        native.sessions && native.sessions.length
                            ? h(
                                  "div",
                                  null,
                                  h("p", { className: "wbMuted" }, "当前聊天 → DSH 会话（" + native.sessions.length + "）"),
                                  native.sessions.slice(0, 20).map(function (s) {
                                      return h(
                                          "p",
                                          { key: s.key, className: "wbMono" },
                                          s.key + "  →  " + (s.sessionId || "") + (s.title ? "  |  " + s.title : "")
                                      );
                                  })
                              )
                            : h("p", { className: "wbMuted" }, "还没有聊天映射（等第一条消息或上面的测试）")
                    )
                ),
                h(
                    "section",
                    { className: "wbCard", "data-kind": "console" },
                    cardHead(
                        "鲸鱼娘调试台（网页 /debug 搬入）",
                        "查看/修改鲸鱼娘的 LLM 映射、记忆与功能开关；prompt 试跑走鲸鱼娘同一套人设与规则。"
                    ),
                    group(
                        "连接与刷新",
                        "读取鲸鱼娘 /debug 的实时状态；映射一致性、记忆概况和打开调试台入口都在这里。",
                        h(
                            "div",
                            { className: "wbActions" },
                            button({ variant: "primary", disabled: wc.busy, onClick: loadConsole }, wc.busy ? "加载中…" : "刷新调试台"),
                            button(
                                {
                                    onClick: function () {
                                        updateWc({ busy: true, msg: "同步中…" });
                                        request(portRef.current, "POST", "/api/brain/sync", { direction: "to-whale" }, { timeoutMs: 60000 })
                                            .then(function () { updateWc({ busy: false, msg: "已把鲸鱼娘映射同步到 DSH 插件" }); loadConsole(); })
                                            .catch(function (e) { updateWc({ busy: false, msg: "同步失败：" + describeError(t, e) }); });
                                    }
                                },
                                "同步到鲸鱼娘"
                            ),
                            button(
                                {
                                    onClick: function () {
                                        updateWc({ busy: true, msg: "读取中…" });
                                        request(portRef.current, "POST", "/api/brain/sync", { direction: "from-whale" }, { timeoutMs: 30000 })
                                            .then(function () { updateWc({ busy: false, msg: "已从鲸鱼娘读取 LLM 映射到插件" }); loadConsole(); })
                                            .catch(function (e) { updateWc({ busy: false, msg: "读取失败：" + describeError(t, e) }); });
                                    }
                                },
                                "从鲸鱼娘读取"
                            ),
                            h("a", { className: "wbLink", href: bridgeUrl(port, "/open?target=debug"), target: "_blank", rel: "noreferrer" }, "打开鲸鱼娘 /debug")
                        ),
                        wc.msg ? h("p", { className: "wbMessage", "data-kind": "info" }, wc.msg) : null,
                        wc.mapping
                            ? h(
                                  "div",
                                  { className: "wbMuted" },
                                  h("p", { className: "wbMono" },
                                      "插件：brain=" + (wc.mapping.brain || "-") + "｜v1=" + (wc.mapping.pluginBaseUrl || "-") + "｜model=" + (wc.mapping.pluginModel || "-")
                                  ),
                                  h("p", { className: "wbMono" },
                                      "鲸鱼娘：provider=" + (wc.mapping.whaleProvider || "-") + "｜baseUrl=" + (wc.mapping.whaleBaseUrl || "-") + "｜model=" + (wc.mapping.whaleModel || "-")
                                  ),
                                  h("p", { className: "wbMono" },
                                      wc.mapping.consistent ? "✔ 映射一致（鲸鱼娘正指向 DSH 插件）" : "✘ 映射不一致（可点「同步到鲸鱼娘」）"
                                  )
                              )
                            : null,
                        wc.memory && wc.memory.current
                            ? h("p", { className: "wbMuted" },
                                  "记忆：会话 " + (wc.memory.current.sessions || 0) + "｜消息 " + (wc.memory.current.messages || 0) + "｜笔记 " + (wc.memory.current.notes || 0)
                              )
                            : null
                    ),
                    group(
                        "LLM 映射",
                        "对应鲸鱼娘 config.json / data/settings.json（provider 固定 custom）。",
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                "鲸鱼娘 LLM 映射（llm.baseUrl）",
                                h("input", {
                                    className: "wbInput wbMono",
                                    type: "text",
                                    value: wc.cfgBaseUrl || "",
                                    spellCheck: false,
                                    autoComplete: "off",
                                    onChange: function (event) {
                                        updateWc({ cfgBaseUrl: event.target.value });
                                    }
                                }),
                                "默认应指向本插件：http://127.0.0.1:" + port + "/v1"
                            ),
                            field(
                                "鲸鱼娘模型（llm.model）",
                                h("input", {
                                    className: "wbInput wbMono",
                                    type: "text",
                                    value: wc.cfgModel || "",
                                    spellCheck: false,
                                    autoComplete: "off",
                                    onChange: function (event) {
                                        updateWc({ cfgModel: event.target.value });
                                    }
                                }),
                                "写回鲸鱼娘 config.json / data/settings.json（provider 固定 custom）"
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ variant: "primary", disabled: wc.busy, onClick: saveWhaleConfig }, "保存鲸鱼娘映射")
                            )
                        )
                    ),
                    group(
                        "记忆",
                        "对应鲸鱼娘 /api/debug/reset；DSH 原生模式下聊天上下文在 DSH 会话里，用「新会话」清。",
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                "清空某个鲸鱼娘会话记忆（key）",
                                h("input", {
                                    className: "wbInput wbMono",
                                    type: "text",
                                    value: wc.resetKey || "",
                                    placeholder: "例如 wechat:u:wxid_xxx 或微信私聊的 chat key",
                                    spellCheck: false,
                                    autoComplete: "off",
                                    onChange: function (event) {
                                        updateWc({ resetKey: event.target.value });
                                    }
                                }),
                                "DSH 原生模式下 DSH 会话上下文在 DSH 侧，这里只清鲸鱼娘自己的记忆。"
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ disabled: wc.busy, onClick: resetWhaleMemory }, "清空该会话记忆")
                            )
                        )
                    ),
                    wc.features && wc.features.features
                        ? group(
                              "功能开关",
                              "点一下立即切换（写回鲸鱼娘 features）。",
                              h(
                                  "div",
                                  { className: "wbActions" },
                                  (Array.isArray(wc.features.features) ? wc.features.features : []).map(function (f) {
                                      var on = Boolean(f.enabled || f.value);
                                      return button(
                                          {
                                              key: f.key,
                                              disabled: wc.busy,
                                              onClick: function () {
                                                  toggleFeature(f);
                                              }
                                          },
                                          (on ? "✓ " : "✗ ") + (f.label || f.key)
                                      );
                                  })
                              )
                          )
                        : null,
                    group(
                        "微信账号与看图",
                        "对应鲸鱼娘 /api/wechat/account；改了桥接会自动重启。",
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                "微信账号（鲸鱼娘）",
                                h(
                                    "select",
                                    {
                                        className: "wbSelect",
                                        value: wc.accountChoice || "",
                                        onChange: function (event) {
                                            updateWc({ accountChoice: event.target.value });
                                        }
                                    },
                                    h("option", { value: "" }, "自动（按最近活跃选）"),
                                    (wc.accounts || []).map(function (a) {
                                        var val = String((a && a.account) || "");
                                        return h("option", { key: val, value: val }, val + ((a && a.nick) ? "（" + a.nick + "）" : ""));
                                    })
                                ),
                                "双开时务必选小号；保存后桥接会在几秒内自动重启。"
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ disabled: wc.busy, onClick: applyAccount }, "应用微信账号"),
                                button({ disabled: wc.busy, onClick: refreshAccounts }, "扫描微信账号"),
                                button({ disabled: wc.busy, onClick: testVision }, "测试看图 Key"),
                                button({ disabled: wc.busy, onClick: backupMemory }, "手动记忆快照")
                            ),
                            wc.visionSample ? h("p", { className: "wbMuted" }, wc.visionSample) : null,
                            wc.memBackupMsg ? h("p", { className: "wbMuted" }, wc.memBackupMsg) : null
                        )
                    ),
                    group(
                        "prompt 预览",
                        "和微信里真实消息共用同一套 persona/规则；只预览提示词，不调用模型。",
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                "prompt 预览（system 提示词）",
                                h("input", {
                                    className: "wbInput",
                                    type: "text",
                                    value: wc.promptText || "",
                                    placeholder: "输入一句话，看鲸鱼娘真实组装出的 system 提示词（走 /api/debug/prompt）",
                                    spellCheck: false,
                                    autoComplete: "off",
                                    onChange: function (event) {
                                        updateWc({ promptText: event.target.value });
                                    },
                                    onKeyDown: function (event) {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            sendWhalePrompt();
                                        }
                                    }
                                }),
                                "回车或点「生成 prompt 预览」生成。"
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ variant: "primary", disabled: wc.busy, onClick: sendWhalePrompt }, wc.busy ? "运行中…" : "生成 prompt 预览")
                            )
                        ),
                        wc.promptSystem
                            ? h(
                                  "div",
                                  { className: "wbReply" },
                                  h("p", { className: "wbMuted" }, "system 提示词（截断显示）："),
                                  h("pre", { className: "wbMono", style: { whiteSpace: "pre-wrap", maxHeight: "260px", overflow: "auto" } },
                                      String(wc.promptSystem).slice(0, 4000))
                              )
                            : null
                    )
                ),
                h(
                    "section",
                    { className: "wbCard", "data-kind": "care" },
                    cardHead(t("careTitle"), t("careDesc")),
                    group(
                        t("careGroupSwitches"),
                        t("careGroupSwitchesDesc"),
                        h(
                            "div",
                            { className: "wbChecks" },
                            checkField(
                                t("careEnabled"),
                                care.enabled,
                                function (value) {
                                    changeCare({ enabled: value });
                                },
                                t("careEnabledHint")
                            ),
                            checkField(
                                t("careOnlyMaster"),
                                care.onlyMaster,
                                function (value) {
                                    changeCare({ onlyMaster: value });
                                },
                                t("careOnlyMasterHint")
                            ),
                            checkField(
                                t("careAllowGroups"),
                                care.allowGroups,
                                function (value) {
                                    changeCare({ allowGroups: value });
                                },
                                t("careAllowGroupsHint")
                            ),
                            checkField(
                                t("careAllowOthers"),
                                care.allowOthers,
                                function (value) {
                                    changeCare({ allowOthers: value });
                                },
                                t("careAllowOthersHint")
                            )
                        )
                    ),
                    group(
                        t("careGroupFrequency"),
                        t("careGroupFrequencyDesc"),
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                t("careEveryMinutes"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 0,
                                    step: 1,
                                    value: care.everyMinutes,
                                    disabled: care.busy || care.saving,
                                    onChange: function (event) {
                                        changeCare({ everyMinutes: event.target.value });
                                    }
                                }),
                                t("careEveryMinutesHint")
                            ),
                            field(
                                t("careJitterMinutes"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 0,
                                    step: 1,
                                    value: care.jitterMinutes,
                                    disabled: care.busy || care.saving,
                                    onChange: function (event) {
                                        changeCare({ jitterMinutes: event.target.value });
                                    }
                                }),
                                t("careJitterMinutesHint")
                            ),
                            field(
                                t("careMaxPerDay"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 0,
                                    step: 1,
                                    value: care.maxPerDay,
                                    disabled: care.busy || care.saving,
                                    onChange: function (event) {
                                        changeCare({ maxPerDay: event.target.value });
                                    }
                                }),
                                t("careMaxPerDayHint")
                            ),
                            field(
                                t("careQuietAfterMinutes"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 0,
                                    step: 1,
                                    value: care.quietAfterMinutes,
                                    disabled: care.busy || care.saving,
                                    onChange: function (event) {
                                        changeCare({ quietAfterMinutes: event.target.value });
                                    }
                                }),
                                t("careQuietAfterMinutesHint")
                            )
                        )
                    ),
                    group(
                        t("careGroupWindows"),
                        t("careGroupWindowsDesc"),
                        h(
                            "div",
                            { className: "wbForm" },
                            field(
                                t("careWindows"),
                                h("input", {
                                    className: "wbInput wbMono",
                                    type: "text",
                                    value: care.windows,
                                    placeholder: t("careWindowsPlaceholder"),
                                    spellCheck: false,
                                    autoComplete: "off",
                                    disabled: care.busy || care.saving,
                                    onChange: function (event) {
                                        changeCare({ windows: event.target.value });
                                    }
                                }),
                                t("careWindowsHint"),
                                { full: true }
                            )
                        )
                    ),
                    h(
                        "div",
                        { className: "wbActions" },
                        button({ disabled: care.busy || care.saving, onClick: reloadCare }, care.busy ? t("careLoading") : t("careReload")),
                        button({ variant: "primary", disabled: care.saving || care.busy, onClick: saveCare }, care.saving ? t("careSaving") : t("careSave")),
                        message(care.msgKind, care.msg)
                    )
                ),
                h(
                    "section",
                    { className: "wbCard", "data-kind": "media" },
                    cardHead(t("mediaCardTitle"), t("mediaCardDesc")),
                    group(
                        t("mediaGroupCacheTitle"),
                        t("mediaGroupCacheDesc"),
                        h(
                            "div",
                            { className: "wbForm" },
                            h(
                                "div",
                                { className: "wbChecks" },
                                checkField(
                                    t("mediaCleanup"),
                                    media.cleanup,
                                    function (value) {
                                        updateMedia({ cleanup: value });
                                    },
                                    t("mediaCleanupHint")
                                )
                            ),
                            field(
                                t("mediaKeepDays"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 1,
                                    max: 365,
                                    step: 1,
                                    value: media.keepDays,
                                    disabled: media.busy || media.saving,
                                    onChange: function (event) {
                                        updateMedia({ keepDays: event.target.value });
                                    }
                                }),
                                t("mediaKeepDaysHint")
                            ),
                            field(
                                t("mediaMaxMB"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 10,
                                    max: 100000,
                                    step: 1,
                                    value: media.maxMB,
                                    disabled: media.busy || media.saving,
                                    onChange: function (event) {
                                        updateMedia({ maxMB: event.target.value });
                                    }
                                }),
                                t("mediaMaxMBHint")
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ disabled: media.busy || media.saving, onClick: reloadMedia }, media.busy ? t("mediaLoading") : t("mediaReload")),
                                button({ variant: "primary", disabled: media.saving || media.busy, onClick: saveMedia }, media.saving ? t("mediaSaving") : t("mediaSave")),
                                message(media.msgKind, media.msg)
                            )
                        )
                    ),
                    group(
                        t("filesGroupTitle"),
                        t("filesGroupDesc"),
                        h(
                            "div",
                            { className: "wbForm" },
                            h(
                                "div",
                                { className: "wbChecks" },
                                checkField(
                                    t("filesEnabled"),
                                    files.enabled,
                                    function (value) {
                                        changeFiles({ enabled: value });
                                    },
                                    t("filesEnabledHint")
                                ),
                                checkField(
                                    t("filesAutoOutbox"),
                                    files.autoOutbox,
                                    function (value) {
                                        changeFiles({ autoOutbox: value });
                                    },
                                    t("filesAutoOutboxHint")
                                )
                            ),
                            field(
                                t("filesMaxFileMB"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 1,
                                    max: 500,
                                    step: 1,
                                    value: files.maxFileMB,
                                    onChange: function (event) {
                                        changeFiles({ maxFileMB: event.target.value });
                                    }
                                }),
                                t("filesMaxFileMBHint")
                            ),
                            field(
                                t("filesLinkTtlHours"),
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 1,
                                    max: 720,
                                    step: 1,
                                    value: files.linkTtlHours,
                                    onChange: function (event) {
                                        changeFiles({ linkTtlHours: event.target.value });
                                    }
                                }),
                                t("filesLinkTtlHoursHint")
                            ),
                            h(
                                "div",
                                { className: "wbActions" },
                                button({ variant: "primary", disabled: files.saving, onClick: saveFiles }, files.saving ? t("filesSaving") : t("filesSave")),
                                message(files.msgKind, files.msg)
                            )
                        )
                    )
                ),
                h(
                    "section",
                    { className: "wbCard", "data-kind": "persona" },
                    cardHead(t("personaTitle"), t("personaDesc")),
                    h("p", { className: "wbHint wbMono" }, persona.path ? t("personaPath", { path: persona.path }) : t("personaPathEmpty")),
                    h(
                        "div",
                        { className: "wbForm" },
                        field(
                            t("personaField"),
                            h("textarea", {
                                className: "wbTextarea wbPersonaText",
                                value: persona.text,
                                rows: 12,
                                placeholder: t("personaPlaceholder"),
                                spellCheck: false,
                                disabled: persona.busy || persona.saving,
                                onChange: function (event) {
                                    changePersonaText(event.target.value);
                                }
                            }),
                            t("personaHint") +
                                " · " +
                                t("personaChars", { count: String(persona.text || "").length }) +
                                (persona.dirty ? " · " + t("personaDirty") : ""),
                            { full: true }
                        ),
                        h(
                            "div",
                            { className: "wbActions" },
                            button({ disabled: persona.busy || persona.saving, onClick: reloadPersona }, persona.busy ? t("personaLoading") : t("personaLoad")),
                            button({ variant: "primary", disabled: persona.saving || persona.busy, onClick: savePersona }, persona.saving ? t("personaSaving") : t("personaSave")),
                            message(persona.msgKind, persona.msg)
                        )
                    )
                ),
                h(
                    "section",
                    { className: "wbSection" },
                    h("h2", { className: "wbSectionTitle" }, t("statusTitle")),
                    h(
                        "div",
                        { className: "wbGrid" },
                        statusCard(t("bridgeTitle"), connection === "online" ? (healthError ? "warn" : "ok") : offline ? "error" : "unknown", bridgeLines),
                        statusCard(t("whaleTitle"), whaleStatus === null ? "unknown" : configured ? "ok" : "warn", whaleLines),
                        statusCard(t("dshTitle"), profileStatus === null ? "unknown" : profileStatus.ready === false ? "warn" : "ok", dshLines),
                        statusCard(t("chainTitle"), chain === null ? "unknown" : chainOnline ? "ok" : (chain.whale && chain.whale.running) ? "warn" : "error", chainLines)
                    )
                ),
                h(
                    "section",
                    { className: "wbCard" },
                    cardHead(t("optionsTitle"), t("optionsDesc")),
                    h(
                        "div",
                        { className: "wbForm" },
                        field(
                            t("fieldWorkspace"),
                            h("input", {
                                className: "wbInput wbMono",
                                type: "text",
                                value: form.workspace,
                                placeholder: t("placeholderWorkspace"),
                                spellCheck: false,
                                autoComplete: "off",
                                onChange: function (event) {
                                    updateDshForm("workspace", event.target.value);
                                }
                            }),
                            t("hintWorkspace")
                        ),
                        field(
                            t("fieldPermission"),
                            h(
                                "select",
                                {
                                    className: "wbSelect",
                                    value: form.permission,
                                    onChange: function (event) {
                                        updateDshForm("permission", event.target.value);
                                    }
                                },
                                PERMISSIONS.map(function (value) {
                                    return h("option", { key: value, value: value }, permissionLabel(t, value));
                                })
                            ),
                            t("hintPermission")
                        ),
                        field(
                            t("fieldMode"),
                            h(
                                "select",
                                {
                                    className: "wbSelect",
                                    value: form.mode,
                                    onChange: function (event) {
                                        updateDshForm("mode", event.target.value);
                                    }
                                },
                                MODES.map(function (value) {
                                    return h("option", { key: value, value: value }, modeLabel(t, value));
                                })
                            ),
                            t("hintMode")
                        ),
                        field(
                            t("fieldTaskModel"),
                            h("input", {
                                className: "wbInput wbMono",
                                type: "text",
                                value: form.model,
                                placeholder: t("placeholderTaskModel"),
                                spellCheck: false,
                                autoComplete: "off",
                                onChange: function (event) {
                                    updateDshForm("model", event.target.value);
                                }
                            }),
                            t("hintTaskModel")
                        ),
                        field(
                            t("fieldReasoningEffort"),
                            h(
                                "select",
                                {
                                    className: "wbSelect",
                                    value: form.reasoningEffort,
                                    onChange: function (event) {
                                        updateDshForm("reasoningEffort", event.target.value);
                                    }
                                },
                                REASONING_EFFORTS.map(function (value) {
                                    return h("option", { key: value, value: value }, reasoningEffortLabel(t, value));
                                })
                            ),
                            t("hintReasoningEffort")
                        ),
                        field(
                            t("fieldSession"),
                            h("input", {
                                className: "wbInput wbMono",
                                type: "text",
                                value: form.defaultSessionId,
                                placeholder: t("placeholderSession"),
                                spellCheck: false,
                                autoComplete: "off",
                                onChange: function (event) {
                                    updateDshForm("defaultSessionId", event.target.value);
                                }
                            }),
                            t("hintSession")
                        ),
                        field(
                            t("fieldPort"),
                            h(
                                "div",
                                { className: "wbInputRow" },
                                h("input", {
                                    className: "wbInput",
                                    type: "number",
                                    min: 1,
                                    max: 65535,
                                    step: 1,
                                    value: form.port,
                                    onChange: function (event) {
                                        updateDshForm("port", event.target.value);
                                    }
                                }),
                                button({ variant: "ghost", onClick: useDraftPort }, t("usePort"))
                            ),
                            t("hintPort")
                        )
                    ),
                    h(
                        "div",
                        { className: "wbRow" },
                        button({ variant: "primary", disabled: saving, onClick: saveSettings }, saving ? t("saving") : t("save")),
                        message(saveResult && saveResult.kind === "ok" ? "ok" : "error", saveMessage(t, saveResult))
                    )
                ),
                h(
                    "section",
                    { className: "wbCard" },
                    cardHead(t("advancedTitle"), t("advancedDesc")),
                    h("p", { className: "wbHint" }, t("keyStatus", { state: hasStoredKey ? t("keyConfigured") : t("keyMissing") })),
                    h(
                        "div",
                        { className: "wbForm" },
                        field(
                            t("fieldUpstreamBaseUrl"),
                            h("input", {
                                className: "wbInput wbMono",
                                type: "text",
                                value: form.upstreamBaseUrl,
                                placeholder: t("placeholderUpstreamBaseUrl"),
                                spellCheck: false,
                                autoComplete: "off",
                                onChange: function (event) {
                                    updateUpstreamForm("upstreamBaseUrl", event.target.value);
                                }
                            }),
                            t("hintUpstreamBaseUrl")
                        ),
                        field(
                            t("fieldUpstreamKey"),
                            h("input", {
                                className: "wbInput wbMono",
                                type: "password",
                                value: form.upstreamKey,
                                placeholder: hasStoredKey ? t("placeholderKeyConfigured") : t("placeholderKeyMissing"),
                                autoComplete: "new-password",
                                onChange: function (event) {
                                    updateUpstreamForm("upstreamKey", event.target.value);
                                }
                            }),
                            t("hintUpstreamKey")
                        ),
                        field(
                            t("fieldUpstreamModel"),
                            h("input", {
                                className: "wbInput wbMono",
                                type: "text",
                                value: form.upstreamModel,
                                placeholder: t("placeholderUpstreamModel"),
                                spellCheck: false,
                                autoComplete: "off",
                                onChange: function (event) {
                                    updateUpstreamForm("upstreamModel", event.target.value);
                                }
                            }),
                            t("hintUpstreamModel")
                        )
                    ),
                    h(
                        "div",
                        { className: "wbRow" },
                        button({ variant: "primary", disabled: upstreamSaving, onClick: saveUpstream }, upstreamSaving ? t("savingUpstream") : t("saveUpstream")),
                        message(upstreamResult && upstreamResult.kind === "ok" ? "ok" : "error", upstreamMessage(t, upstreamResult))
                    )
                ),
                h(
                    "section",
                    { className: "wbCard" },
                    cardHead(t("whaleSectionTitle"), t("whaleSectionDesc")),
                    h(
                        "div",
                        { className: "wbRow" },
                        h(
                            "span",
                            { className: "wbBadge", "data-state": configured === null ? "unknown" : configured ? "ok" : "warn" },
                            t("currentProvider") + "：" + (configured === null ? t("stateUnknown") : configured ? t("configuredYes") : t("configuredNo"))
                        ),
                        h("span", { className: "wbMuted" }, t("whaleUrlHint", { url: whaleBase }))
                    ),
                    h(
                        "div",
                        { className: "wbRow" },
                        button({ variant: "primary", disabled: whaleOp !== null || offline, onClick: function () { runWhaleOp("adopt"); } }, whaleOp === "adopt" ? t("adopting") : t("adopt")),
                        button({ disabled: whaleOp !== null || offline, onClick: function () { runWhaleOp("revert"); } }, whaleOp === "revert" ? t("reverting") : t("revert")),
                        button({ onClick: function () { openWhalePage("web"); } }, t("openWhale")),
                        button({ onClick: function () { openWhalePage("debug"); } }, t("openDebug"))
                    ),
                    h(
                        "div",
                        { className: "wbRow" },
                        button({ disabled: offline || whaleProcBusy !== null, onClick: function () { controlWhale("start"); } }, whaleProcBusy === "start" ? t("startingWhale") : t("startWhale")),
                        button({ disabled: offline || whaleProcBusy !== null || whaleRunning !== true, onClick: function () { controlWhale("stop"); } }, whaleProcBusy === "stop" ? t("stoppingWhale") : t("stopWhale"))
                    ),
                    message(whaleMessageKind(whaleResult), whaleMessage(t, whaleResult))
                ),
                h(
                    "section",
                    { className: "wbCard" },
                    cardHead(t("benchTitle"), t("benchDesc")),
                    h("p", { className: "wbHint" }, t("benchHint")),
                    field(
                        t("promptLabel"),
                        h("textarea", {
                            className: "wbTextarea",
                            value: prompt,
                            rows: 4,
                            placeholder: t("promptPlaceholder"),
                            spellCheck: false,
                            disabled: running,
                            onChange: function (event) {
                                setPrompt(event.target.value);
                            }
                        })
                    ),
                    h(
                        "div",
                        { className: "wbRow" },
                        button({ variant: "primary", disabled: running || offline, onClick: runTask }, running ? t("runningBtn") : t("run")),
                        running ? button({ variant: "ghost", onClick: cancelTask }, t("cancel")) : null
                    ),
                    taskResultView(t, taskResult, elapsedMs),
                    h(
                        "div",
                        { className: "wbSubhead" },
                        h("h3", { className: "wbSubtitle" }, t("tasksTitle")),
                        h("span", { className: "wbMuted" }, t("tasksCount", { count: String(tasks.length) })),
                        button({ variant: "ghost", disabled: tasksLoading, onClick: refreshTaskList }, tasksLoading ? t("refreshing") : t("refreshTasks"))
                    ),
                    tasksError ? message("error", t("tasksError", { error: describeError(t, tasksError) })) : null,
                    tasks.length === 0
                        ? h("p", { className: "wbMuted" }, t("tasksEmpty"))
                        : h(
                              "ul",
                              { className: "wbTasks" },
                              taskRows.map(function (row) {
                                  return h(
                                      "li",
                                      { key: row.key, className: "wbTask" },
                                      h(
                                          "div",
                                          { className: "wbTaskTop" },
                                          h("span", { className: "wbTaskStatus", "data-state": row.ok ? "ok" : "error" }, row.ok ? t("taskOk") : t("taskFailed")),
                                          row.timeText ? h("span", { className: "wbMuted wbMono" }, row.timeText) : null,
                                          row.durationMs !== null ? h("span", { className: "wbMuted wbMono" }, formatDuration(t, row.durationMs)) : null,
                                          row.toolCalls !== null ? h("span", { className: "wbMuted" }, t("taskTools", { value: row.toolCalls })) : null,
                                          row.sessionId ? h("span", { className: "wbMuted wbMono" }, t("taskSession", { value: row.sessionId })) : null
                                      ),
                                      h("p", { className: "wbTaskPrompt", title: row.prompt }, row.prompt),
                                      row.errorText ? h("p", { className: "wbTaskError" }, t("taskErrorPrefix", { error: row.errorText })) : null
                                  );
                              })
                          )
                ),
                h(
                    "section",
                    { className: "wbCard" },
                    cardHead(t("maintenanceTitle"), t("maintenanceDesc")),
                    h(
                        "div",
                        { className: "wbRow" },
                        button({ disabled: rebuilding || offline, onClick: rebuildProfile }, rebuilding ? t("rebuilding") : t("rebuild")),
                        message(rebuildResult && rebuildResult.kind === "ok" ? "ok" : "error", rebuildMessage(t, rebuildResult))
                    )
                )
            );
        }

        /* ================================================================== */
        /* 样式（宿主主题 token，不写死亮色）                                  */
        /* ================================================================== */

        var CSS = [
            ".wbIcon{display:block}",
            ".wbPage{box-sizing:border-box;height:100%;width:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:20px;padding:0 clamp(20px,4vw,40px) 40px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}",
            ".wbPage>*{flex:none;width:100%;max-width:960px}",
            ".wbHead{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px}",
            "[data-platform=darwin] .wbHead{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}",
            ".wbTitle{margin:0;font-size:20px;font-weight:500;line-height:28px}",
            ".wbIntro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}",
            ".wbEndpoint{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}",
            ".wbHeadActions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}",
            ".wbUpdated{color:var(--dsw-alias-label-tertiary);font-size:12px}",
            ".wbSection{display:flex;flex-direction:column;gap:10px}",
            ".wbSectionTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}",
            ".wbGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}",
            ".wbCard{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:16px 18px}",
            ".wbCardHead{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}",
            ".wbCardTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}",
            ".wbCardDesc{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}",
            ".wbStatusCard{box-sizing:border-box;min-width:0;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:14px 16px}",
            ".wbStatusHead{display:flex;align-items:center;gap:8px}",
            ".wbStatusTitle{font-size:13.5px;font-weight:600}",
            ".wbStatusBody{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:12.5px}",
            ".wbDot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
            ".wbDot[data-state=ok]{background:var(--dsw-alias-state-success-primary)}",
            ".wbDot[data-state=warn]{background:var(--dsw-alias-state-warn-primary)}",
            ".wbDot[data-state=error]{background:var(--dsw-alias-state-error-primary)}",
            ".wbDot[data-state=busy]{background:var(--dsw-alias-state-business-primary)}",
            ".wbInfoLine{display:flex;gap:8px;min-width:0}",
            ".wbInfoKey{flex:none;color:var(--dsw-alias-label-tertiary)}",
            ".wbInfoValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}",
            ".wbMono{font-family:var(--dsw-font-mono);font-size:12px}",
            ".wbMuted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}",
            ".wbHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}",
            ".wbBadge{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
            ".wbBadge[data-state=ok]{color:var(--dsw-alias-state-success-primary)}",
            ".wbBadge[data-state=warn]{color:var(--dsw-alias-state-warn-primary)}",
            ".wbBadge[data-state=error]{color:var(--dsw-alias-state-error-primary)}",
            ".wbBadge[data-state=busy]{color:var(--dsw-alias-state-business-primary)}",
            ".wbForm{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px 16px}",
            ".wbActions{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0}",
            ".wbForm>.wbActions{padding-top:4px}",
            ".wbActions>.wbMessage{flex:1 1 100%;margin:0;text-align:right}",
            ".wbActions .wbBtn{flex:0 0 auto}",
            ".wbGroup{display:flex;flex-direction:column;gap:12px;min-width:0;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}",
            ".wbCard>.wbCardHead+.wbGroup{padding-top:0;border-top:0}",
            ".wbGroupHead{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px}",
            ".wbGroupTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}",
            ".wbGroupDesc{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}",
            ".wbFieldFull{grid-column:1/-1}",
            ".wbPersonaText{min-height:220px;max-height:52vh;font-family:var(--dsw-font-mono);font-size:12.5px;line-height:1.55}",
            ".wbReply{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}",
            ".wbReply>p{margin:0;font-size:12.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}",
            ".wbLink{color:var(--dsw-alias-state-business-primary);font-size:13px;text-decoration:none}",
            ".wbLink:hover{text-decoration:underline}",
            ".wbChecks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 16px;min-width:0}",
            ".wbCheckField{display:flex;align-items:flex-start;gap:8px;min-width:0;cursor:pointer}",
            ".wbCheckField>input{flex:none;width:16px;height:16px;margin-top:2px;accent-color:var(--dsw-alias-button-primary-fill)}",
            ".wbCheckField>input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}",
            ".wbCheckText{display:flex;flex-direction:column;gap:2px;min-width:0}",
            ".wbCheckLabel{color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500}",
            ".wbField{display:flex;flex-direction:column;gap:6px;min-width:0}",
            ".wbLabel{color:var(--dsw-alias-label-secondary);font-size:12.5px;font-weight:500}",
            ".wbInput,.wbSelect,.wbTextarea{box-sizing:border-box;width:100%;min-height:34px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
            ".wbInput::placeholder,.wbTextarea::placeholder{color:var(--dsw-alias-label-caption)}",
            ".wbInput:focus-visible,.wbSelect:focus-visible,.wbTextarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}",
            ".wbTextarea{resize:vertical;min-height:90px;line-height:1.5}",
            ".wbInputRow{display:flex;align-items:center;gap:6px}",
            ".wbRow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-width:0}",
            ".wbCard>.wbRow:has(.wbBtn){justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}",
            ".wbCard>.wbRow:has(.wbBtn) .wbMessage{flex:1 1 100%;margin:0;text-align:right}",
            ".wbHeadActions{justify-content:flex-end}",
            ".wbBtn{min-height:34px;padding-left:16px;padding-right:16px}",
            ".wbBtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:32px;padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}",
            ".wbBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
            ".wbBtn:disabled{opacity:.5;cursor:not-allowed}",
            ".wbBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}",
            ".wbBtn[data-variant=primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary-inverted,#fff))}",
            ".wbBtn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
            ".wbBtn[data-variant=ghost]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding-left:8px;padding-right:8px}",
            ".wbBtn[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
            ".wbMessage{margin:0;font-size:12.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}",
            ".wbMessage[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}",
            ".wbMessage[data-kind=error]{color:var(--dsw-alias-state-error-primary)}",
            ".wbMessage[data-kind=info]{color:var(--dsw-alias-label-secondary)}",
            ".wbBanner{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}",
            ".wbBanner[data-kind=error]{border-color:var(--dsw-alias-state-error-primary)}",
            ".wbBannerTitle{margin:0;font-size:13.5px;font-weight:600;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}",
            ".wbBanner[data-kind=error] .wbBannerTitle{color:var(--dsw-alias-state-error-primary)}",
            ".wbBannerText{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}",
            ".wbPre{margin:0;max-height:260px;overflow:auto;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}",
            ".wbResult{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}",
            ".wbResultMeta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
            ".wbResultLabel{color:var(--dsw-alias-label-tertiary);font-size:12px}",
            ".wbSubhead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}",
            ".wbSubtitle{margin:0;font-size:13.5px;font-weight:600}",
            ".wbTasks{list-style:none;display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto;margin:0;padding:0}",
            ".wbTask{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}",
            ".wbTaskTop{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:12px}",
            ".wbTaskStatus{font-size:11.5px;font-weight:600;white-space:nowrap}",
            ".wbTaskStatus[data-state=ok]{color:var(--dsw-alias-state-success-primary)}",
            ".wbTaskStatus[data-state=error]{color:var(--dsw-alias-state-error-primary)}",
            ".wbTaskPrompt{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12.5px}",
            ".wbTaskError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:17px;overflow-wrap:anywhere}"
        ].join("\n");

        /* ================================================================== */
        /* 插件入口                                                            */
        /* ================================================================== */

        function apply(ctx) {
            ctx.effect(function () {
                return ctx.locale.register(NS, { zh: ZH, en: EN });
            }, "dsh-whale-bridge: dictionaries");

            try {
                fallbackT = ctx.locale.bind(NS);
            } catch (error) {
                fallbackT = null;
            }
            var t = makeTranslator(fallbackT);

            ctx.effect(function () {
                if (typeof document === "undefined") return undefined;
                var stale = document.querySelectorAll('style[data-plugin-css="' + STYLE_ID + '"]');
                for (var index = 0; index < stale.length; index++) {
                    if (stale[index].parentNode) stale[index].parentNode.removeChild(stale[index]);
                }
                var style = document.createElement("style");
                style.dataset.plugin = "dsh-whale-bridge";
                style.dataset.pluginCss = STYLE_ID;
                style.textContent = CSS;
                var parent = document.head || document.documentElement;
                if (parent) parent.appendChild(style);
                return function () {
                    if (style.parentNode) style.parentNode.removeChild(style);
                };
            }, "dsh-whale-bridge: styles");

            /* 两个槽位都注册成功后，向桥接自报一次（失败静默），供宿主日志确认插件已加载。 */
            var applied = { sidebarEntry: false, mainEntry: false, reported: false };
            function markApplied(entry) {
                applied[entry] = true;
                if (applied.reported || !applied.sidebarEntry || !applied.mainEntry) return;
                applied.reported = true;
                reportEvent(readStoredPort(), {
                    event: "client-applied",
                    panelId: PANEL_ID,
                    sidebarEntry: true,
                    mainEntry: true
                });
            }

            ctx.slots.inject("sidebar.panellist", function () {
                var dispose = ctx.slots.register(
                    {
                        name: "sidebar.panellist",
                        id: PANEL_ID,
                        order: 12,
                        label: function () {
                            return t("panel");
                        },
                        locale: NS
                    },
                    WhaleBridgeIcon
                );
                markApplied("sidebarEntry");
                return dispose;
            });

            ctx.slots.inject("main", function () {
                var dispose = ctx.slots.register(
                    {
                        name: "main",
                        key: PANEL_ID,
                        locale: NS
                    },
                    WhaleBridgePanel
                );
                markApplied("mainEntry");
                return dispose;
            });
        }

        return {
            inject: ["slots", "locale", "layout"],
            apply: apply
        };
    }
});
