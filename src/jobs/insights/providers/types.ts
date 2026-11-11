export interface AiInsights {
  reviewInsights: {
    sentiment: 'positive' | 'mixed' | 'negative'
    pros: string[]
    cons: string[]
    representative_quotes: string[]
  } | null
  careerInsights: {
    job_roles: Array<{ title: string; salary_range: string; description: string }>
    complementary_skills: string[]
    growth_potential: string
  }
}
