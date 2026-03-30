import { Box, Flex, Input, Heading, Spinner, Center, Text } from '@chakra-ui/react'
import { useState } from 'react'
import { HubProvider, useHub } from './context/HubContext'
import Sidebar from './components/Sidebar'
import PatModal from './components/PatModal'
import ViewTabs from './components/ViewTabs'
import ContentDrawer from './components/ContentDrawer'
import ArticleList from './views/ArticleList'
import GmbView from './views/GmbView'
import LinkedinList from './views/LinkedinList'
import CalendarView from './views/CalendarView'

function PipelineView({ search }) {
  const { articles, setSelectedItem } = useHub()

  let items = articles.filter((a) => a.isDraft)

  if (search.trim()) {
    const q = search.toLowerCase()
    items = items.filter(
      (a) =>
        (a.frontmatter?.title || '').toLowerCase().includes(q) ||
        (a.frontmatter?.description || '').toLowerCase().includes(q)
    )
  }

  if (items.length === 0) {
    return (
      <Text color="gray.400" fontSize="sm" textAlign="center" mt={8}>
        Aucun brouillon dans la pipeline.
      </Text>
    )
  }

  return (
    <Box>
      {items.map((item) => (
        <Box
          key={item.path}
          border="1px solid"
          borderColor="gray.200"
          borderRadius={8}
          p={3}
          mb={2}
          cursor="pointer"
          _hover={{ borderColor: 'brand.400' }}
          onClick={() => setSelectedItem(item)}
        >
          <Flex justify="space-between" align="center">
            <Text fontWeight={600} fontSize={14} lineClamp={1} flex={1} mr={2}>
              {item.frontmatter?.title || item.slug || 'Sans titre'}
            </Text>
            <Text fontSize={12} color="gray.400">
              {item.type}
            </Text>
          </Flex>
          <Flex gap={1.5} mt={1}>
            <Text fontSize={11} color="gray.500">
              {item.project}
            </Text>
            {item.frontmatter?.date && (
              <Text fontSize={11} color="gray.400">
                — {item.frontmatter.date}
              </Text>
            )}
          </Flex>
        </Box>
      ))}
    </Box>
  )
}

function AppContent() {
  const { activeProject, activeTab, loading, pat } = useHub()
  const [search, setSearch] = useState('')

  const isPipeline = activeProject === '__pipeline'

  const projectLabel = isPipeline ? 'Pipeline' : activeProject || 'Content Hub'

  const renderView = () => {
    if (isPipeline) {
      return <PipelineView search={search} />
    }

    switch (activeTab) {
      case 'articles':
        return <ArticleList search={search} />
      case 'gmb':
        return <GmbView />
      case 'linkedin':
        return <LinkedinList search={search} />
      case 'calendar':
        return <CalendarView />
      default:
        return <ArticleList search={search} />
    }
  }

  return (
    <Flex h="100vh">
      <Sidebar />

      <Flex flex={1} direction="column" minW={0}>
        {/* Header bar */}
        <Flex
          px={6}
          py={3}
          align="center"
          gap={4}
          borderBottom="1px solid"
          borderColor="gray.200"
          bg="white"
          flexShrink={0}
        >
          <Heading size="md" color="gray.800" flexShrink={0}>
            {projectLabel}
          </Heading>
          <Input
            placeholder="Rechercher..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
            maxW="300px"
            borderRadius="md"
          />
        </Flex>

        {/* Tabs (only for project view, not pipeline) */}
        {!isPipeline && activeProject && (
          <Box px={6} bg="white" borderBottom="1px solid" borderColor="gray.200" flexShrink={0}>
            <ViewTabs />
          </Box>
        )}

        {/* Content area */}
        <Box flex={1} overflowY="auto" p={6}>
          {loading ? (
            <Center h="200px">
              <Spinner size="lg" color="brand.500" />
            </Center>
          ) : (
            renderView()
          )}
        </Box>
      </Flex>

      {/* Drawer */}
      <ContentDrawer />

      {/* PAT modal */}
      {!pat && <PatModal />}
    </Flex>
  )
}

export default function App() {
  return (
    <HubProvider>
      <AppContent />
    </HubProvider>
  )
}
