# ycfs3-ssww 工程纪律（AGENTS.md）

竖屏小游戏：上半 35% 为横版放置自动战斗（复用 godot-roguelike 的主角与敌人资源），下半 65% 为 8×8 五行元素三消；三消消除后合成技能供上半主角自动释放（消除即资源：消除数量越多技能越强，档位充能 + CD 门控，无独立生成次数限制）；主角可杀怪升级，挑战更难关卡。技术路线：纯 HTML5 Canvas 2D（逻辑分辨率 720×1280），序列帧资源直接复用 godot-roguelike。

## 目录约定

- `scripts/{core,assets,board,battle,skills,meta,api,ui}` 模块划分见 docs/design/00-宏观框架.md 第 5 节；文件头注释标相对路径
- `assets/sprites/...` 贴图按来源子目录存放（player/slime/fox_anim/zombie/snake/tiger/boss 等，沿用 godot-roguelike 原始目录名，帧号清单见 docs/design/04-敌人设计.md 第 6 节）
- `docs/standards/` 审核协议与 TDD 标准；`docs/architecture/` 系统文档；`docs/changelog.md` 改动记录
- `.claude/skills/ssww-*` 项目 skill 真身；`.agents/skills/` 为其 junction 镜像

## 红线

1. 提交信息 `<type>(<scope>): <中文动宾>`，不加 AI 署名；`.tmp/` 永不提交。
2. 项目 skill 的创建/修改/提交必须走 `ssww-create-skill` 门禁链，禁止绕门禁直接 commit skill 目录。
3. 数值公式冻结前必须有可机械复算的数字例（见 `docs/standards/TDD_Standard.md` 第 5 节）。
4. 复用 godot-roguelike 资源时裁剪 autoload 依赖必须逐项核对，不留悬空引用。
5. 送审/验收走 `ssww-review-ruling`，codex 出网先设本机代理 `http://127.0.0.1:1080`。
