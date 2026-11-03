"""屋苑 → 所屬地區（用嚟做麵包屑、同區連結、總覽分組）。先查 tools/area/data.py 有冇列嗰個屋苑，冇就按 estates.district（地產網嘅分區字串）對應。
對唔到嘅屋苑會放「其他」，唔會亂估。新加屋苑要補一行（見 gen.py 結尾列出「未對應地區」）。"""
DISTRICT_AREA = {
    "四小龍": "sham-shui-po", "長沙灣": "sham-shui-po", "深水埗": "sham-shui-po", "美孚": "sham-shui-po",
    "油麻地": "yau-tsim-mong", "太子": "yau-tsim-mong", "旺角": "yau-tsim-mong", "大角咀": "yau-tsim-mong",
    "何文田": "kowloon-city", "黃埔": "kowloon-city", "海逸": "kowloon-city",
    "九龍灣": "kwun-tong", "藍田": "kwun-tong", "觀塘": "kwun-tong",
    "新蒲崗": "wong-tai-sin",
    "將軍澳": "tseung-kwan-o", "康城": "tseung-kwan-o", "寶琳": "tseung-kwan-o",
    "火炭": "sha-tin", "沙田第一城": "sha-tin",
    "天水圍": "yuen-long", "元朗東南": "yuen-long",
    "東涌市中心": "islands",
    "荃灣西": "tsuen-wan", "深井 / 青龍頭": "tsuen-wan",
    "海怡": "southern", "香港仔 / 田灣": "southern",
    "康怡": "eastern", "西灣河": "eastern", "太古城": "eastern",
    "銅鑼灣": "wan-chai",
}
