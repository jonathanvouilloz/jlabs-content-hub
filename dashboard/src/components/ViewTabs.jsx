import { Tabs } from '@chakra-ui/react'
import { useHub } from '../context/HubContext'

export default function ViewTabs() {
  const { articles, activeProject, activeTab, setActiveTab } = useHub()

  // Filter articles by active project (show all for pipeline)
  const filtered =
    activeProject === '__pipeline'
      ? articles
      : articles.filter((a) => a.project === activeProject)

  const counts = {
    articles: filtered.filter((a) => a.type === 'article').length,
    gmb: filtered.filter((a) => a.type === 'gmb').length,
    linkedin: filtered.filter((a) => a.type === 'linkedin').length,
  }

  const isPipeline = activeProject === '__pipeline'

  const getVisibleTabs = () => {
    const tabs = ['articles']
    if (isPipeline || counts.gmb > 0) tabs.push('gmb')
    if (isPipeline || counts.linkedin > 0) tabs.push('linkedin')
    tabs.push('calendar')
    return tabs
  }

  const visibleTabs = getVisibleTabs()

  const tabLabels = {
    articles: `Articles (${counts.articles})`,
    gmb: `GMB (${counts.gmb})`,
    linkedin: `LinkedIn (${counts.linkedin})`,
    calendar: 'Calendrier',
  }

  return (
    <Tabs.Root
      value={activeTab}
      onValueChange={(e) => setActiveTab(e.value)}
      variant="line"
    >
      <Tabs.List>
        {visibleTabs.map((tab) => (
          <Tabs.Trigger key={tab} value={tab} fontSize="sm" fontWeight="medium">
            {tabLabels[tab]}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  )
}
