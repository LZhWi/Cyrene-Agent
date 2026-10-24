import { Jieba } from "@node-rs/jieba";

export interface SearchToken {
  word: string;
  tag: string;
  isStop: boolean;
  isNoun: boolean;
}

export interface TextCandidate<T> {
  item: T;
  text: string;
}

export interface RankedTextCandidate<T> {
  item: T;
  score: number;
}

const jieba = new Jieba();
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "有", "不", "也", "就", "都", "这", "那", "还", "要",
  "和", "与", "或", "但", "而", "且", "及", "之", "为", "上", "下", "中", "里", "外", "前", "后", "左", "右",
  "到", "去", "来", "从", "把", "被", "让", "给", "对", "吗", "呢", "吧", "啊", "嘛", "哦", "嗯", "呀", "哇",
  "很", "太", "更", "最", "非", "没", "将", "已", "能", "会", "可", "以", "好", "多", "少", "大", "小", "真",
  "个", "些", "点", "样", "种", "哪", "谁", "什", "做", "当", "看", "听", "说", "想", "觉", "知", "道",
  "过", "完", "着", "住", "得", "地", "于", "其", "该", "我们", "你们", "他们", "她们", "它们", "自己", "什么",
  "怎么", "为什么", "因为", "所以", "这个", "那个", "这些", "那些", "这里", "那里", "一个", "一种", "一些", "的话",
  "时候", "地方", "东西", "事情", "问题", "就是", "可以", "但是", "没有", "不要", "不是", "不会", "不能", "应该",
  "已经", "可能", "觉得", "知道", "告诉",
]);
const STOP_TAGS = new Set(["u", "c", "p", "d", "r", "y", "o", "e", "m", "q", "f"]);
const NOUN_TAGS = new Set(["n", "nr", "ns", "nt", "nz", "ng", "vn", "an"]);
const STOP_WEIGHT = 0.3;
const NOUN_WEIGHT = 1.3;
const customWords = new Set<string>();
let customWordsVersion = 0;

export function registerJiebaCustomWord(word: string): void {
  if (word.length >= 2 && !customWords.has(word)) customWordsVersion++;
  customWords.add(word);
}

export function registerJiebaCustomWords(words: Iterable<string>): void {
  for (const word of words) registerJiebaCustomWord(word);
}

export function getJiebaCustomWordsVersion(): number {
  return customWordsVersion;
}

function mergeCustomWords(tokens: string[]): string[] {
  if (customWords.size === 0 || tokens.length < 2) return tokens;
  const sortedWords = [...customWords].sort((a, b) => b.length - a.length);
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const word of sortedWords) {
      const wordTokens = word.split("");
      if (wordTokens.every((part, offset) => tokens[i + offset] === part)) {
        result.push(word);
        i += wordTokens.length;
        matched = true;
        break;
      }
    }
    if (!matched) result.push(tokens[i++]);
  }
  return result;
}

export function tokenizeText(text: string): SearchToken[] {
  if (/^[a-zA-Z0-9\s]+$/.test(text)) {
    return text.split(/\s+/).filter(Boolean).map((word) => ({
      word: word.toLowerCase(), tag: "eng", isStop: false, isNoun: false,
    }));
  }

  try {
    return mergeCustomWords(jieba.cut(text, true)).map((word) => {
      const first = jieba.tag(word, true)[0] ?? { word, tag: "x" };
      return {
        word: word.toLowerCase(),
        tag: first.tag,
        isStop: STOP_WORDS.has(word) || STOP_TAGS.has(first.tag),
        isNoun: NOUN_TAGS.has(first.tag),
      };
    });
  } catch {
    return text.split(/([\u4e00-\u9fff]|[a-zA-Z]+|\d+)/).filter(Boolean).flatMap((part) => {
      if (/[\u4e00-\u9fff]/.test(part)) {
        return [...part].map((word) => ({ word, tag: "x", isStop: STOP_WORDS.has(word), isNoun: false }));
      }
      return [{ word: part.toLowerCase(), tag: "eng", isStop: false, isNoun: false }];
    });
  }
}

function scoreBm25(
  queryTokens: SearchToken[],
  docTokens: SearchToken[],
  docFreq: Map<string, number>,
  totalDocs: number,
  avgDocLen: number,
): number {
  const termFrequency = new Map<string, number>();
  for (const token of docTokens) termFrequency.set(token.word, (termFrequency.get(token.word) ?? 0) + 1);

  let score = 0;
  for (const queryToken of queryTokens) {
    const documentFrequency = docFreq.get(queryToken.word) ?? 0;
    if (documentFrequency === 0) continue;
    const frequency = termFrequency.get(queryToken.word) ?? 0;
    const idf = Math.log((totalDocs - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1);
    const numerator = frequency * 2.2;
    const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * (avgDocLen ? docTokens.length / avgDocLen : 1));
    let termScore = idf * (numerator / denominator);
    if (queryToken.isNoun) termScore *= NOUN_WEIGHT;
    if (queryToken.isStop) termScore *= STOP_WEIGHT;
    score += termScore;
  }
  return score;
}

export function rankTextCandidates<T>(
  query: string,
  candidates: readonly TextCandidate<T>[],
  topK = candidates.length,
): RankedTextCandidate<T>[] {
  if (candidates.length === 0 || topK <= 0) return [];
  const queryTokens = tokenizeText(query);
  return rankTokenizedCandidates(queryTokens, candidates.map((candidate) => ({
    item: candidate.item,
    tokens: tokenizeText(candidate.text),
  })), topK);
}

export function rankTokenizedCandidates<T>(
  queryTokens: SearchToken[],
  candidates: readonly { item: T; tokens: SearchToken[] }[],
  topK = candidates.length,
): RankedTextCandidate<T>[] {
  if (candidates.length === 0 || topK <= 0) return [];
  const docTokens = candidates.map((candidate) => candidate.tokens);
  const documentFrequency = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const word of new Set(tokens.map((token) => token.word))) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const averageLength = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / candidates.length;
  const queryWords = new Set(queryTokens.map((token) => token.word));

  return candidates.map((candidate, index) => {
    const tokens = docTokens[index];
    const hasMatch = tokens.some((token) => queryWords.has(token.word));
    return {
      item: candidate.item,
      score: hasMatch ? scoreBm25(queryTokens, tokens, documentFrequency, candidates.length, averageLength) : 0,
    };
  }).sort((a, b) => b.score - a.score).slice(0, topK);
}
