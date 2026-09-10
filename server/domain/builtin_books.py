"""内置公版书馆藏清单（模块 02 FR-03 v2）：Project Gutenberg 来源，40 本分三档难度。

每条的 `pg_id` 都用 Gutenberg 官方全量目录 `pg_catalog.csv` 现场核对过标题与作者
（2026-08-19 核对，40/40 命中）。ID 在 Gutenberg 是永久标识不会改，因此清单里落值，
但 seed 脚本保留 `--verify` 模式重新拉目录复核，避免「凭记忆写 id」那类事故。

难度分档参照 Gutenberg Bookshelves 分类 + 英语学习界通行的分级读物梯度：
starter  ≈ CEFR A2-B1，童书与寓言，句子短、从句浅
core     ≈ CEFR B1-B2，通俗小说与冒险科幻，叙事线性
deep     ≈ CEFR B2-C1，文学经典与思想著作，长句与古体词多
"""

from dataclasses import dataclass

# Gutenberg 的 epub 直链（无图版体积小、解析快，图片对点读无价值）
EPUB_URL = "https://www.gutenberg.org/cache/epub/{pg_id}/pg{pg_id}.epub"

DIFFICULTY_LABEL = {
    "starter": "入门",
    "core": "进阶",
    "deep": "精读",
}


@dataclass(frozen=True)
class BuiltinBook:
    pg_id: int
    slug: str
    title: str
    author: str
    difficulty: str  # starter | core | deep
    tags: tuple[str, ...]
    blurb: str
    # 官方目录里的作者姓氏与展示名不一致时显式给出（如 Sun Tzu 在目录中记作 Sunzi）
    author_key: str | None = None
    # 检索封面用的通行书名。Gutenberg 存的是冗长全称，而书目站按通行名收录
    # （"The Life and Adventures of Robinson Crusoe" 在 Open Library 上就叫 "Robinson Crusoe"）
    search_title: str | None = None

    @property
    def url(self) -> str:
        return EPUB_URL.format(pg_id=self.pg_id)


CATALOG: tuple[BuiltinBook, ...] = (
    # ---------------------------------------------------------------- 入门
    BuiltinBook(
        11, "alice-in-wonderland", "Alice's Adventures in Wonderland", "Lewis Carroll",
        "starter", ("童话", "幻想"),
        "掉进兔子洞的爱丽丝。对话短促、场景跳跃，是英语精读最常见的第一本原著。",
    ),
    BuiltinBook(
        55, "wizard-of-oz", "The Wonderful Wizard of Oz", "L. Frank Baum",
        "starter", ("童话", "冒险"),
        "多萝西沿黄砖路寻找回家的方法。用词平实，重复句式多，适合建立语感。",
    ),
    BuiltinBook(
        16, "peter-pan", "Peter Pan", "J. M. Barrie",
        "starter", ("童话", "幻想"),
        "永无岛与不肯长大的男孩。叙述者语气亲昵，口语化表达密集。",
    ),
    BuiltinBook(
        11339, "aesops-fables", "Aesop's Fables", "Aesop",
        "starter", ("寓言", "短篇"),
        "几百则独立小寓言，每则几十词。适合碎片时间读完整篇而不是读半章。",
    ),
    BuiltinBook(
        236, "the-jungle-book", "The Jungle Book", "Rudyard Kipling",
        "starter", ("动物", "短篇"),
        "狼群养大的莫格里。动物拟人叙事，自然与动作类词汇集中。",
    ),
    BuiltinBook(
        271, "black-beauty", "Black Beauty", "Anna Sewell",
        "starter", ("动物", "成长"),
        "一匹马的第一人称自述。章节短小独立，时态与人称变化清晰。",
    ),
    BuiltinBook(
        45, "anne-of-green-gables", "Anne of Green Gables", "L. M. Montgomery",
        "starter", ("成长", "乡村"),
        "话痨红发女孩安妮的乡村生活。大量生活对白，日常词汇覆盖面广。",
    ),
    BuiltinBook(
        46, "a-christmas-carol", "A Christmas Carol", "Charles Dickens",
        "starter", ("节日", "中篇"),
        "吝啬鬼斯克鲁奇的一夜。五章读完，是狄更斯里最短最好入口的一本。",
    ),
    BuiltinBook(
        74, "tom-sawyer", "The Adventures of Tom Sawyer", "Mark Twain",
        "starter", ("成长", "冒险"),
        "密西西比河边的顽童。方言拼写会给初读者一点挑战，正好练「听懂口音」。",
    ),
    BuiltinBook(
        2591, "grimms-fairy-tales", "Grimms' Fairy Tales", "Brothers Grimm",
        "starter", ("童话", "短篇"),
        "两百多则格林童话。每则独立成篇，故事骨架熟悉，靠已知情节猜生词最省力。",
    ),
    BuiltinBook(
        113, "the-secret-garden", "The Secret Garden", "Frances Hodgson Burnett",
        "starter", ("成长", "自然"),
        "被遗忘的花园与被忽视的孩子。景物描写细腻，形容词与自然词汇丰富。",
    ),
    BuiltinBook(
        289, "wind-in-the-willows", "The Wind in the Willows", "Kenneth Grahame",
        "starter", ("动物", "田园"),
        "河鼠、鼹鼠与蟾蜍先生。文字比一般童书讲究，是入门档里最耐读的散文。",
    ),
    # ---------------------------------------------------------------- 进阶
    BuiltinBook(
        1661, "sherlock-holmes", "The Adventures of Sherlock Holmes", "Arthur Conan Doyle",
        "core", ("推理", "短篇"),
        "十二个独立探案。每篇一次读完，推理对白是练「精确表达」的好材料。",
    ),
    BuiltinBook(
        120, "treasure-island", "Treasure Island", "Robert Louis Stevenson",
        "core", ("冒险", "海洋"),
        "藏宝图与独腿海盗。航海词汇成体系，海盗腔调是英语文化的活化石。",
    ),
    BuiltinBook(
        215, "call-of-the-wild", "The Call of the Wild", "Jack London",
        "core", ("动物", "荒野"),
        "从家犬到头狼。全书七章不到三万词，节奏紧、动词力量感强。",
    ),
    BuiltinBook(
        35, "the-time-machine", "The Time Machine", "H. G. Wells",
        "core", ("科幻", "中篇"),
        "八十万年后的地球。科幻始祖之一，说明性长句适合练结构拆解。",
    ),
    BuiltinBook(
        36, "war-of-the-worlds", "The War of the Worlds", "H. G. Wells",
        "core", ("科幻", "灾难"),
        "火星人入侵伦敦。第一人称目击式叙述，紧张感强，地名密集。",
    ),
    BuiltinBook(
        84, "frankenstein", "Frankenstein", "Mary Shelley",
        "core", ("哥特", "科幻"),
        "造物与造物主。书信体嵌套叙事，长句多，是进阶档里偏难的一本。",
    ),
    BuiltinBook(
        345, "dracula", "Dracula", "Bram Stoker",
        "core", ("哥特", "恐怖"),
        "日记、信件与电报拼成的吸血鬼档案。多人称多文体，语域切换练习。",
    ),
    BuiltinBook(
        42, "jekyll-and-hyde", "The Strange Case of Dr. Jekyll and Mr. Hyde",
        "Robert Louis Stevenson",
        "core", ("哥特", "中篇"),
        "体面绅士的另一面。篇幅极短但用词考究，一周能精读完的完整作品。",
    ),
    BuiltinBook(
        103, "around-the-world-80-days", "Around the World in Eighty Days", "Jules Verne",
        "core", ("冒险", "旅行"),
        "福格先生的环球赌局。地理与交通词汇成串出现，情节推进快不易走神。",
    ),
    BuiltinBook(
        164, "20000-leagues", "Twenty Thousand Leagues under the Sea", "Jules Verne",
        "core", ("科幻", "海洋"),
        "鹦鹉螺号与尼摩船长。海洋生物学名词密集，适合带着词典读的题材控。",
    ),
    BuiltinBook(
        514, "little-women", "Little Women", "Louisa May Alcott",
        "core", ("家庭", "成长"),
        "马奇家四姐妹。家庭对白量大，人物语气差别明显，适合分角色朗读。",
    ),
    BuiltinBook(
        174, "dorian-gray", "The Picture of Dorian Gray", "Oscar Wilde",
        "core", ("哥特", "讽刺"),
        "画像替他老去。王尔德的警句几乎每页都有，是背诵金句的富矿。",
    ),
    BuiltinBook(
        5200, "metamorphosis", "Metamorphosis", "Franz Kafka",
        "core", ("荒诞", "中篇"),
        "推销员变成甲虫的那个早晨。英译本句式冷静克制，篇幅两万词出头。",
    ),
    BuiltinBook(
        98, "tale-of-two-cities", "A Tale of Two Cities", "Charles Dickens",
        "core", ("历史", "革命"),
        "伦敦与巴黎的双城记。开篇排比是英语文学最著名的段落之一。",
    ),
    # ---------------------------------------------------------------- 精读
    BuiltinBook(
        521, "robinson-crusoe", "The Life and Adventures of Robinson Crusoe", "Daniel Defoe",
        "deep", ("冒险", "十八世纪"),
        "荒岛二十八年。十八世纪英语，拼写与句法都偏古，读它等于读语言史。",
        search_title="Robinson Crusoe",
    ),
    BuiltinBook(
        829, "gullivers-travels", "Gulliver's Travels", "Jonathan Swift",
        "deep", ("讽刺", "十八世纪"),
        "小人国与大人国背后的政治讽刺。反语密集，字面意思往往不是真意思。",
    ),
    BuiltinBook(
        64317, "the-great-gatsby", "The Great Gatsby", "F. Scott Fitzgerald",
        "deep", ("现代", "美国"),
        "盖茨比与对岸的绿灯。句子现代好读，难在隐喻和留白，适合做精读讨论。",
    ),
    BuiltinBook(
        1260, "jane-eyre", "Jane Eyre", "Charlotte Brontë",
        "deep", ("成长", "维多利亚"),
        "家庭教师的第一人称自述。心理描写绵长，从句套从句是常态。",
    ),
    BuiltinBook(
        768, "wuthering-heights", "Wuthering Heights", "Emily Brontë",
        "deep", ("哥特", "维多利亚"),
        "呼啸山庄的两代恩怨。约克郡方言对白是全书最大的阅读门槛。",
    ),
    BuiltinBook(
        1400, "great-expectations", "Great Expectations", "Charles Dickens",
        "deep", ("成长", "维多利亚"),
        "匹普的远大前程。狄更斯最成熟的长篇，人物语域差异极大。",
    ),
    BuiltinBook(
        2701, "moby-dick", "Moby Dick", "Herman Melville",
        "deep", ("海洋", "史诗"),
        "追捕白鲸的执念。捕鲸术语 + 圣经腔 + 百科式插章，公认难啃但值得。",
    ),
    BuiltinBook(
        76, "huckleberry-finn", "Adventures of Huckleberry Finn", "Mark Twain",
        "deep", ("成长", "美国"),
        "哈克与吉姆的木筏。全书用方言拼写写成，逐字读会很慢，但耳朵会打开。",
    ),
    BuiltinBook(
        219, "heart-of-darkness", "Heart of Darkness", "Joseph Conrad",
        "deep", ("殖民", "中篇"),
        "刚果河溯流而上。康拉德的英语是二外者写的母语级散文，密度极高。",
    ),
    BuiltinBook(
        205, "walden", "Walden", "Henry David Thoreau",
        "deep", ("散文", "自然"),
        "瓦尔登湖畔两年。说理散文，长句与从句结构是练「读懂论证」的标准件。",
    ),
    BuiltinBook(
        132, "the-art-of-war", "The Art of War", "Sun Tzu",
        "deep", ("兵法", "短篇"),
        "孙子兵法英译。条目式短句，中英对照读能同时校准两种语言的表达差。",
        author_key="Sunzi",
    ),
    BuiltinBook(
        2680, "meditations", "Meditations", "Marcus Aurelius",
        "deep", ("哲学", "格言"),
        "皇帝写给自己的札记。段落极短可随意切入，斯多葛术语反复出现好记。",
    ),
    BuiltinBook(
        1232, "the-prince", "The Prince", "Niccolò Machiavelli",
        "deep", ("政治", "短篇"),
        "君主论英译。论证紧凑、结论直白，适合练「抓论点」式的快读。",
    ),
    BuiltinBook(
        161, "sense-and-sensibility", "Sense and Sensibility", "Jane Austen",
        "deep", ("爱情", "摄政时期"),
        "达什伍德姐妹的理智与情感。奥斯汀的反讽藏在语序里，慢读才尝得出。",
    ),
)

BY_SLUG = {b.slug: b for b in CATALOG}


def catalog_by_difficulty() -> dict[str, list[BuiltinBook]]:
    out: dict[str, list[BuiltinBook]] = {"starter": [], "core": [], "deep": []}
    for b in CATALOG:
        out[b.difficulty].append(b)
    return out
