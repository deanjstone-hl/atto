import { BookOpen } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { KeySpec } from '@/lib/dashboard/shape'
import { SectionEmpty } from './section-empty'

type KeySpecsCardProps = {
  specs: KeySpec[]
}

export function KeySpecsCard({ specs }: KeySpecsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Key specs</CardTitle>
        <CardDescription>Battery, charging, performance and dimensions</CardDescription>
      </CardHeader>
      <CardContent>
        {specs.length === 0 ? (
          <SectionEmpty
            icon={BookOpen}
            title="No specs recorded"
            description="Add battery, charging and performance details from the manual to see them here."
          />
        ) : (
          <dl className="divide-y">
            {specs.map((spec) => (
              <div key={spec.label} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground">
                  {spec.label}
                  {spec.reference && <span className="block text-2xs">{spec.reference}</span>}
                </dt>
                <dd className="text-right font-medium tabular-nums">{spec.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  )
}
