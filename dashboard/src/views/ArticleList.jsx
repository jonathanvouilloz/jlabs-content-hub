import { Box, VStack, Text, Flex, Badge, Input, Heading } from '@chakra-ui/react'
import { useState } from 'react'
import { useHub } from '../context/HubContext'
import TypeBadge from '../components/TypeBadge'
import ProjectBadge from '../components/ProjectBadge'
import PublishButton from '../components/PublishButton'

export default function ArticleList({ search: externalSearch }) {
  const { articles, activeProject, setSelectedItem } = useHub()
  const [localSearch, setLocalSearch] = useState('')

  const search = externalSearch ?? localSearch
  const showSearchInput = externalSearch === undefined

  const isPipeline = activeProject === '__pipeline'

  // Filter articles by project and type
  let items = articles.filter((a) => a.type === 'article')
  if (isPipeline) {
    items = items.filter((a) => a.isDraft)
  } else {
    items = items.filter((a) => a.project === activeProject)
  }

  // Apply search filter
  if (search.trim()) {
    const q = search.toLowerCase()
    items = items.filter(
      (a) =>
        (a.title || '').toLowerCase().includes(q) ||
        (a.frontmatter?.description || '').toLowerCase().includes(q)
    )
  }

  const drafts = items.filter((a) => a.isDraft)
  const published = items.filter((a) => !a.isDraft)

  const renderCard = (item) => (
    <Box
      key={item.path || item.title}
      border="1px solid"
      borderColor="gray.200"
      borderRadius={8}
      p={3}
      mb={2}
      cursor="pointer"
      _hover={{ borderColor: 'brand.400' }}
      onClick={() => setSelectedItem(item)}
    >
      <Flex justify="space-between" align="flex-start" mb={1}>
        <Text fontWeight={600} fontSize={14} lineClamp={1} flex={1} mr={2}>
          {item.title}
        </Text>
        <PublishButton item={item} />
      </Flex>

      <Flex gap={1.5} align="center" flexWrap="wrap" mb={1.5}>
        <TypeBadge type={item.type} />
        {isPipeline && <ProjectBadge project={item.project} />}
        {(item.frontmatter?.tags || []).map((tag) => (
          <Badge key={tag} fontSize="10px" variant="subtle" colorPalette="gray">
            {tag}
          </Badge>
        ))}
      </Flex>

      <Flex gap={2} align="center">
        {item.frontmatter?.date && (
          <Text fontSize={12} color="gray.500" flexShrink={0}>
            {item.frontmatter.date}
          </Text>
        )}
        {item.frontmatter?.description && (
          <Text fontSize={12} color="gray.500" lineClamp={1}>
            {item.frontmatter.description}
          </Text>
        )}
      </Flex>
    </Box>
  )

  return (
    <Box>
      {showSearchInput && (
        <Input
          placeholder="Rechercher un article..."
          value={localSearch}
          onChange={(e) => setLocalSearch(e.target.value)}
          size="sm"
          mb={4}
          borderRadius="md"
        />
      )}

      {drafts.length > 0 && (
        <Box mb={6}>
          <Heading size="sm" mb={3} color="gray.700">
            A publier ({drafts.length})
          </Heading>
          <VStack align="stretch" gap={0}>
            {drafts.map(renderCard)}
          </VStack>
        </Box>
      )}

      {published.length > 0 && (
        <Box>
          <Heading size="sm" mb={3} color="gray.700">
            Publies ({published.length})
          </Heading>
          <VStack align="stretch" gap={0}>
            {published.map(renderCard)}
          </VStack>
        </Box>
      )}

      {items.length === 0 && (
        <Text color="gray.400" fontSize="sm" textAlign="center" mt={8}>
          Aucun article trouve.
        </Text>
      )}
    </Box>
  )
}
