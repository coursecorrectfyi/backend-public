/**
 * A small, realistic catalogue and a fake "semantic" embedding for the search
 * golden set (test/api/search-golden.test.ts).
 *
 * The fake embedding stands in for text-embedding-004 and knows a fixed list of
 * concepts. A text's vector is the normalized sum of one axis per concept it
 * mentions, so:
 *   - texts about the same concepts are close ("website" ≈ "web development"),
 *     like a real model's synonyms;
 *   - texts with no concept in common have cosine similarity 0;
 *   - text with no known concept at all (gibberish, typos) points along an
 *     axis no resource uses. A real model would still return its nearest
 *     neighbours for such a query, just with lower similarity, which is why
 *     the golden set checks that nonsense finds nothing.
 * The fake deliberately knows no misspellings: typo tolerance has to come from
 * the keyword side, which also has to work when the embedding API is down.
 *
 * Resources are embedded with their title's concepts counting double
 * (documentEmbedding): the real embedding input starts with the title, which
 * dominates it. Without this, a course with four topics in its summary would
 * be as far from "python" as from any of them, even with Python in its title.
 */
import { createHash } from 'node:crypto'
import { EMBEDDING_DIMENSIONS } from '../fakes/embedding.js'
import { insertResource } from './fixtures.js'
import { db } from '../fakes/db.js'
import { refreshVocabulary } from '../../src/search/vocabulary.js'

/** Concept → words or phrases that mention it (lowercase, matched as whole words). */
const CONCEPTS: Record<string, string[]> = {
  python: ['python'],
  data: ['data', 'dataset', 'datasets'],
  analysis: ['analysis', 'analyse', 'analyze', 'analytics', 'analyst', 'analysts'],
  pandas: ['pandas', 'numpy'],
  data_science: ['data science', 'data scientist'],
  programming: ['programming', 'coding', 'programmer', 'software'],
  web: ['web', 'website', 'websites', 'html', 'css', 'wordpress', 'frontend'],
  javascript: ['javascript', 'node.js', 'react', 'typescript'],
  machine_learning: ['machine learning', 'supervised learning', 'neural networks', 'deep learning', 'pytorch'],
  ai: ['ai', 'artificial intelligence', 'generative', 'prompt engineering'],
  project_management: ['project management', 'project manager', 'agile', 'scrum', 'jira'],
  spreadsheets: ['excel', 'spreadsheet', 'spreadsheets', 'pivot tables'],
  sql: ['sql', 'database', 'databases'],
  finance: ['finance', 'financial', 'accounting', 'bookkeeping'],
  marketing: ['marketing', 'seo', 'advertising'],
  cloud: ['cloud', 'aws', 'kubernetes', 'docker', 'containers', 'devops'],
  design: ['ux', 'user experience', 'figma', 'wireframing', 'prototyping'],
  photography: ['photography', 'photo', 'photos', 'photoshop', 'camera'],
  languages: ['spanish', 'french', 'conversational', 'grammar'],
  music: ['guitar', 'chords', 'music'],
  speaking: ['public speaking', 'presentation', 'presentations'],
  study_skills: ['study', 'note-taking', 'study habits'],
}

const CONCEPT_AXES = Object.keys(CONCEPTS)
/** The axis used for text that mentions no known concept. No resource uses it. */
const UNKNOWN_AXIS = EMBEDDING_DIMENSIONS - 1

function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text)
}

/** The concepts a text mentions (exported so tests can explain a failure). */
export function conceptsOf(text: string): string[] {
  const lower = text.toLowerCase()
  return CONCEPT_AXES.filter(c => CONCEPTS[c]!.some(p => mentions(lower, p)))
}

/**
 * The fake embedding of a text: unit length, one axis per concept mentioned.
 * `extraAxis` adds a small component on an axis of its own, to give resources
 * about the same concepts distinct (but still close) vectors.
 */
export function conceptEmbedding(text: string, extraAxis?: number): number[] {
  return weightedEmbedding([{ text, weight: 1 }], extraAxis)
}

/** A resource's fake embedding: its title's concepts count double (see the header). */
export function documentEmbedding(entry: { title: string; ai_summary?: string | null; skills?: string[] | null }, extraAxis?: number): number[] {
  return weightedEmbedding([
    { text: entry.title, weight: 2 },
    { text: [entry.ai_summary ?? '', ...(entry.skills ?? [])].join(' '), weight: 1 },
  ], extraAxis)
}

function weightedEmbedding(parts: Array<{ text: string; weight: number }>, extraAxis?: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  for (const { text, weight } of parts) {
    for (const c of conceptsOf(text)) {
      const axis = CONCEPT_AXES.indexOf(c)
      v[axis] = Math.max(v[axis]!, weight)
    }
  }
  if (!v.some(x => x !== 0)) v[UNKNOWN_AXIS] = 1 // no known concept
  if (extraAxis !== undefined) v[CONCEPT_AXES.length + extraAxis] = 0.2
  const norm = Math.hypot(...v)
  return v.map(x => x / norm)
}

type ResourceInsert = NonNullable<Parameters<typeof insertResource>[0]>

export interface CatalogueEntry extends ResourceInsert {
  title: string
  /** false: inserted without an embedding (the embedding job hasn't run for it yet). */
  embedded?: boolean
}

/**
 * The golden catalogue. Titles are unique so assertions can use them. Texts
 * are written like the AI-normalized catalogue (factual summaries, skill tags).
 */
export const CATALOGUE: CatalogueEntry[] = [
  // ── Python and data ─────────────────────────────────────────────────────────
  {
    title: 'Python for Data Analysis', provider: 'udemy', level: 'beginner', rating: 4.6, num_ratings: 12_000,
    ai_summary: 'Use pandas and NumPy to clean, analyse and visualise data sets. For people who know basic Python.',
    skills: ['Python', 'pandas', 'NumPy', 'Data Analysis'],
  },
  {
    title: 'Python for Everybody', provider: 'coursera', institution: 'University of Michigan', level: 'beginner',
    rating: 4.8, num_ratings: 200_000,
    ai_summary: 'An introduction to programming with Python for people with no prior experience.',
    skills: ['Python', 'Programming'],
  },
  {
    title: 'Complete Python Bootcamp: Zero to Hero', provider: 'udemy', level: 'all_levels', rating: 4.8, num_ratings: 20_000,
    ai_summary: 'Covers Python 3 from the basics to object-oriented programming, with exercises and projects.',
    skills: ['Python', 'Object-Oriented Programming'],
  },
  {
    title: 'Python Quick Tips', provider: 'udemy', level: 'intermediate', rating: 5.0, num_ratings: 1,
    ai_summary: 'Short videos with idioms that make Python code shorter.',
    skills: ['Python'],
  },
  {
    title: 'Python Crash Course', provider: 'edx', level: 'beginner', rating: 4.4, num_ratings: 3_000, embedded: false,
    ai_summary: 'A fast-paced introduction to Python syntax, functions and files.',
    skills: ['Python'],
  },
  {
    title: 'Applied Data Science with Python', provider: 'coursera', institution: 'University of Michigan',
    level: 'intermediate', resource_type: 'program', rating: 4.5, num_ratings: 30_000,
    ai_summary: 'Apply statistics, machine learning and text analysis to real data sets with pandas and scikit-learn.',
    skills: ['Python', 'Data Science', 'Machine Learning', 'pandas'],
  },
  {
    title: 'Data Analysis with Excel', provider: 'coursera', level: 'beginner', rating: 4.5, num_ratings: 8_000,
    ai_summary: 'Clean and summarise business data with formulas, pivot tables and charts in Excel.',
    skills: ['Excel', 'Data Analysis', 'Pivot Tables'],
  },
  {
    title: 'SQL for Data Analysts', provider: 'udemy', level: 'beginner', rating: 4.6, num_ratings: 15_000,
    ai_summary: 'Write SQL queries to filter, join and aggregate data in relational databases.',
    skills: ['SQL', 'Data Analysis', 'Databases'],
  },
  // ── Web ─────────────────────────────────────────────────────────────────────
  {
    title: 'The Complete Web Development Bootcamp', provider: 'udemy', level: 'beginner', rating: 4.7, num_ratings: 250_000,
    ai_summary: 'Build websites and web apps with HTML, CSS, JavaScript, Node.js and React.',
    skills: ['HTML', 'CSS', 'JavaScript', 'Node.js', 'React'],
  },
  {
    title: 'WordPress for Beginners: Create a Website', provider: 'udemy', level: 'beginner', rating: 4.5, num_ratings: 9_000,
    ai_summary: 'Set up a WordPress site with themes, pages and plugins, without writing code.',
    skills: ['WordPress', 'Web Design'],
  },
  {
    title: 'JavaScript: Understanding the Weird Parts', provider: 'udemy', level: 'intermediate', rating: 4.6, num_ratings: 40_000,
    ai_summary: 'Closures, prototypes and the event loop: how JavaScript works under the hood.',
    skills: ['JavaScript'],
  },
  {
    title: 'React - The Complete Guide', provider: 'udemy', level: 'all_levels', rating: 4.6, num_ratings: 180_000,
    ai_summary: 'Build single-page applications with React, hooks, Redux and Next.js.',
    skills: ['React', 'JavaScript', 'Redux'],
  },
  // ── Machine learning and AI ─────────────────────────────────────────────────
  {
    title: 'Machine Learning Specialization', provider: 'coursera', institution: 'Stanford University', level: 'beginner',
    resource_type: 'program', rating: 4.9, num_ratings: 150_000,
    ai_summary: 'Supervised learning, unsupervised learning and recommender systems, taught with Python.',
    skills: ['Machine Learning', 'Supervised Learning', 'Python'],
  },
  {
    title: 'Deep Learning with PyTorch', provider: 'edx', level: 'intermediate', rating: 4.5, num_ratings: 2_000,
    ai_summary: 'Train neural networks for images and text with PyTorch.',
    skills: ['Deep Learning', 'PyTorch', 'Neural Networks'],
  },
  {
    title: 'Generative AI for Everyone', provider: 'coursera', institution: 'DeepLearning.AI', level: 'beginner',
    rating: 4.8, num_ratings: 50_000,
    ai_summary: 'What generative AI can and cannot do, and how to use it at work. No coding required.',
    skills: ['Generative AI', 'Prompt Engineering'],
  },
  // ── Business ────────────────────────────────────────────────────────────────
  {
    title: 'Google Project Management: Professional Certificate', provider: 'coursera', institution: 'Google',
    level: 'beginner', resource_type: 'certification', rating: 4.8, num_ratings: 100_000,
    ai_summary: 'Plan, run and close projects with traditional and Agile methods. Prepares for entry-level project manager roles.',
    skills: ['Project Management', 'Agile', 'Scrum'],
  },
  {
    title: 'Agile with Atlassian Jira', provider: 'coursera', institution: 'Atlassian', level: 'beginner',
    rating: 4.7, num_ratings: 20_000,
    ai_summary: 'Run Scrum and Kanban boards in Jira.',
    skills: ['Agile', 'Jira', 'Scrum'],
  },
  {
    title: 'Excel Skills for Business', provider: 'coursera', institution: 'Macquarie University', level: 'beginner',
    resource_type: 'program', rating: 4.9, num_ratings: 60_000,
    ai_summary: 'Spreadsheet formulas, charts and automation for everyday business tasks.',
    skills: ['Excel', 'Spreadsheets'],
  },
  {
    title: 'Financial Accounting Fundamentals', provider: 'coursera', institution: 'University of Virginia',
    level: 'beginner', rating: 4.7, num_ratings: 5_000,
    ai_summary: 'Read balance sheets, income statements and cash-flow statements.',
    skills: ['Accounting', 'Financial Statements'],
  },
  {
    title: 'Digital Marketing Strategy', provider: 'edx', level: 'intermediate', rating: 4.3, num_ratings: 1_500,
    ai_summary: 'Plan campaigns across SEO, social media and paid advertising, and measure their results.',
    skills: ['Digital Marketing', 'SEO', 'Social Media'],
  },
  // ── Cloud ───────────────────────────────────────────────────────────────────
  {
    title: 'Kubernetes for Absolute Beginners', provider: 'udemy', level: 'beginner', rating: 4.6, num_ratings: 35_000,
    ai_summary: 'Deploy containers to a Kubernetes cluster with pods, deployments and services.',
    skills: ['Kubernetes', 'Docker', 'Containers'],
  },
  {
    title: 'AWS Certified Solutions Architect Associate', provider: 'udemy', level: 'intermediate',
    resource_type: 'certification', rating: 4.7, num_ratings: 200_000,
    ai_summary: 'Design resilient systems on AWS and prepare for the Solutions Architect Associate exam.',
    skills: ['AWS', 'Cloud Architecture'],
  },
  // ── Design and creative ─────────────────────────────────────────────────────
  {
    title: 'UX Design Fundamentals', provider: 'coursera', level: 'beginner', rating: 4.6, num_ratings: 7_000,
    ai_summary: 'User research, wireframing and prototyping in Figma.',
    skills: ['User Experience', 'Figma', 'Wireframing'],
  },
  {
    title: 'Adobe Photoshop Essentials', provider: 'udemy', level: 'beginner', rating: 4.6, num_ratings: 25_000,
    ai_summary: 'Retouch photos, work with layers and masks, and export images for the web.',
    skills: ['Photoshop', 'Photo Editing'],
  },
  {
    title: 'Photography Masterclass', provider: 'udemy', level: 'all_levels', rating: 4.7, num_ratings: 60_000,
    ai_summary: 'Camera settings, composition and lighting for portraits and landscapes.',
    skills: ['Photography', 'Lighting'],
  },
  // ── Other subjects ──────────────────────────────────────────────────────────
  {
    title: 'Spanish for Beginners', provider: 'udemy', level: 'beginner', rating: 4.5, num_ratings: 10_000,
    ai_summary: 'Everyday conversational Spanish: greetings, ordering food and asking for directions.',
    skills: ['Spanish', 'Conversational Spanish'],
  },
  {
    title: 'Guitar Lessons for Beginners', provider: 'udemy', level: 'beginner', rating: 4.7, num_ratings: 30_000,
    ai_summary: 'Open chords, strumming patterns and your first songs on guitar.',
    skills: ['Guitar', 'Music'],
  },
  {
    title: 'Public Speaking and Presentation Skills', provider: 'edx', level: 'all_levels', rating: 4.4, num_ratings: 4_000,
    ai_summary: 'Structure a talk, handle nerves and deliver presentations with confidence.',
    skills: ['Public Speaking', 'Presentations'],
  },
  // ── Decoys ──────────────────────────────────────────────────────────────────
  {
    // Shares only generic query words ("best", "course", "beginners") with many queries, several times over.
    title: 'The Best Course for Beginners: Start Here', provider: 'udemy', level: 'beginner', rating: 4.2, num_ratings: 300,
    ai_summary: 'The best course for beginners who want better study habits. This course covers note-taking and planning for beginners.',
    skills: ['Study Skills', 'Note-Taking'],
  },
]

/**
 * A fixed UUID per title. The id is every order's final tiebreaker, so random
 * ids would make any tie come out differently from run to run: with fixed
 * ones, the golden results are the same on every run.
 */
export function catalogueId(title: string): string {
  const hex = createHash('sha256').update(`search-catalogue:${title}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Inserts the catalogue (embedded with documentEmbedding unless `embedded: false`)
 * and rebuilds the search vocabulary, as the embed job does after ingestion.
 * Returns the rows by title.
 */
export async function insertCatalogue(entries: CatalogueEntry[] = CATALOGUE) {
  const byTitle = new Map<string, Awaited<ReturnType<typeof insertResource>>>()
  for (const [i, { embedded = true, ...entry }] of entries.entries()) {
    const row = await insertResource({
      id: catalogueId(entry.title), ...entry, embedding: embedded ? documentEmbedding(entry, i) : null,
    })
    byTitle.set(entry.title, row)
  }
  await refreshVocabulary(db)
  return byTitle
}
