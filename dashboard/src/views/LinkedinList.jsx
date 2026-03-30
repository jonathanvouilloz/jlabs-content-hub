import { Box, VStack, Text, Flex, Badge, Heading } from '@chakra-ui/react'
import { useHub } from '../context/HubContext'
import TypeBadge from '../components/TypeBadge'
import ProjectBadge from '../components/ProjectBadge'
import PublishButton from '../components/PublishButton'

export default function LinkedinList({ search }) {
  const { articles, activeProject, setSelectedItem } = useHub()

  const isPipeline = activeProject === '__pipeline'

  let items = articles.filter((a) => a.type === 'linkedin')
  if (isPipeline) {
    items = items.filter((a) => a.isDraft)
  } else {
    items = items.filter((a) => a.project === activeProject)
  }

  // Apply search filter
  if (search && search.trim()) {
    const q = search.toLowerCase()
    items = items.filter(
      (a) =>
        (a.title || '').toLowerCase().includes(q) ||
        (a.frontmatter?.description || '').toLowerCase().includes(q)
    )
  }

  const drafts = items.filter((a) => a.isDraft)
  const published = items.filter((a) => !a.isDraft)

  const dayColors = {
    Lundi: 'orange',
    Mercredi: 'teal',
    Vendredi: 'purple',
  }

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
        {item.frontmatter?.day && (
          <Badge
            colorPalette={dayColors[item.frontmatter.day] || 'gray'}
            fontSize="10px"
          >
            {item.frontmatter.day}
          </Badge>
        )}
        {/* Fallback: check flat day property */}
        {!item.frontmatter?.day && item.day && (
          <Badge
            colorPalette={dayColors[item.day] || 'gray'}
            fontSize="10px"
          >
            {item.day}
          </Badge>
        )}
      </Flex>

      <Flex gap={2} align="center">
        {item.frontmatter?.date && (
          <Text fontSize={12} color="gray.500" flexShrink={0}>
            {item.frontmatter.date}
          </Text>
        )}
        {(item.frontmatter?.article_slug || item.article_slug) && (
          <Text fontSize={12} color="gray.500">
            Article:{' '}
            <Text as="span" color="brand.500" fontWeight="medium">
              {item.frontmatter?.article_slug || item.article_slug}
            </Text>
          </Text>
        )}
      </Flex>

      {item.frontmatter?.description && (
        <Text fontSize={12} color="gray.500" lineClamp={1} mt={1}>
          {item.frontmatter.description}
        </Text>
      )}
    </Box>
  )

  return (
    <Box>
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
          Aucun post LinkedIn trouve.
        </Text>
      )}
    </Box>
  )
}
