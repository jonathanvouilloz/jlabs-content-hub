import { Box, VStack, Text, Flex, Badge } from '@chakra-ui/react'
import { useHub } from '../context/HubContext'

export default function Sidebar() {
  const { articles, activeProject, setActiveProject, setActiveTab, setPat } = useHub()

  // Compute counts per project
  const projectMap = new Map()
  articles.forEach((item) => {
    const proj = item.project
    if (!projectMap.has(proj)) {
      projectMap.set(proj, { articles: 0, gmb: 0, linkedin: 0 })
    }
    const counts = projectMap.get(proj)
    if (item.type === 'article') counts.articles++
    else if (item.type === 'gmb') counts.gmb++
    else if (item.type === 'linkedin') counts.linkedin++
  })

  // Total drafts across all types
  const totalDrafts = articles.filter((a) => a.isDraft).length

  // Projects sorted alphabetically
  const projects = [...projectMap.keys()].sort((a, b) =>
    a.localeCompare(b, 'fr', { sensitivity: 'base' })
  )

  const handleProjectClick = (name) => {
    setActiveProject(name)
    setActiveTab('articles')
  }

  const handleResetPat = () => {
    localStorage.removeItem('github_pat')
    setPat(null)
  }

  return (
    <Box
      w="260px"
      minW="260px"
      h="100vh"
      bg="gray.50"
      borderRight="1px solid"
      borderColor="gray.200"
      display="flex"
      flexDirection="column"
    >
      {/* Header */}
      <Box px={5} py={4} borderBottom="1px solid" borderColor="gray.200">
        <Text fontSize="lg" fontWeight="bold" color="gray.800">
          JLabs Content Hub
        </Text>
      </Box>

      {/* Pipeline */}
      <Box
        px={5}
        py={3}
        cursor="pointer"
        bg={activeProject === '__pipeline' ? 'gray.100' : 'transparent'}
        color={activeProject === '__pipeline' ? 'brand.500' : 'gray.700'}
        _hover={{ bg: 'gray.100' }}
        onClick={() => handleProjectClick('__pipeline')}
      >
        <Flex justify="space-between" align="center">
          <Text fontWeight="semibold" fontSize="sm">
            Pipeline
          </Text>
          <Badge colorPalette="purple" borderRadius="full" px={2}>
            {totalDrafts}
          </Badge>
        </Flex>
      </Box>

      {/* Project list */}
      <VStack
        align="stretch"
        gap={0}
        flex={1}
        overflowY="auto"
        pt={2}
      >
        {projects.map((name) => {
          const counts = projectMap.get(name)
          const isActive = activeProject === name
          const details = [
            counts.articles > 0 && `${counts.articles} article${counts.articles > 1 ? 's' : ''}`,
            counts.gmb > 0 && `${counts.gmb} GMB`,
            counts.linkedin > 0 && `${counts.linkedin} LinkedIn`,
          ]
            .filter(Boolean)
            .join(', ')

          return (
            <Box
              key={name}
              px={5}
              py={2.5}
              cursor="pointer"
              bg={isActive ? 'gray.100' : 'transparent'}
              color={isActive ? 'brand.500' : 'gray.700'}
              _hover={{ bg: 'gray.100' }}
              onClick={() => handleProjectClick(name)}
            >
              <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                {name}
              </Text>
              {details && (
                <Text fontSize="xs" color="gray.500" mt={0.5}>
                  {details}
                </Text>
              )}
            </Box>
          )
        })}
      </VStack>

      {/* Footer */}
      <Box px={5} py={3} borderTop="1px solid" borderColor="gray.200">
        <Text
          fontSize="xs"
          color="gray.500"
          cursor="pointer"
          _hover={{ color: 'red.500' }}
          onClick={handleResetPat}
        >
          Reset PAT
        </Text>
      </Box>
    </Box>
  )
}
