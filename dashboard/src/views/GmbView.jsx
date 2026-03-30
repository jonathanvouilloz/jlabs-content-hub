import { Box, Table, Text, Flex, Badge, Heading } from '@chakra-ui/react'
import { useHub } from '../context/HubContext'
import PublishButton from '../components/PublishButton'

export default function GmbView() {
  const { articles, activeProject, setSelectedItem } = useHub()

  const isPipeline = activeProject === '__pipeline'

  // Get all GMB items for current project
  let gmbItems = articles.filter((a) => a.contentType === 'gmb')
  if (isPipeline) {
    gmbItems = gmbItems.filter((a) => a.isDraft)
  } else {
    gmbItems = gmbItems.filter((a) => a.project === activeProject)
  }

  // Each gmbItem is a file with gmbData array of posts
  const groups = gmbItems.map((gmbItem) => {
    const posts = (gmbItem.gmbData || []).map((post, idx) => ({
      ...post,
      _index: idx,
    }))
    return { gmbItem, posts }
  })

  const handlePostClick = (gmbItem, post, index) => {
    setSelectedItem({
      type: 'gmb-post',
      project: gmbItem.project,
      title: post.title || `GMB Post ${index + 1}`,
      frontmatter: {
        title: post.title || `GMB Post ${index + 1}`,
        date: post.scheduled_at?.split('T')[0],
      },
      isDraft: gmbItem.isDraft,
      gmbPost: post,
      parentItem: gmbItem,
    })
  }

  if (gmbItems.length === 0) {
    return (
      <Text color="gray.400" fontSize="sm" textAlign="center" mt={8}>
        Aucun contenu GMB trouve.
      </Text>
    )
  }

  return (
    <Box>
      {groups.map(({ gmbItem, posts }) => (
        <Box key={gmbItem.path || gmbItem.title} mb={6}>
          {/* Group header */}
          <Flex
            align="center"
            justify="space-between"
            mb={3}
            pb={2}
            borderBottom="1px solid"
            borderColor="gray.200"
          >
            <Flex align="center" gap={2}>
              <Heading size="sm" color="gray.700">
                {gmbItem.frontmatter?.title || gmbItem.slug || 'GMB'}
              </Heading>
              <Badge colorPalette="gray" fontSize="xs">
                {posts.length} post{posts.length > 1 ? 's' : ''}
              </Badge>
              <Badge
                colorPalette={gmbItem.isDraft ? 'orange' : 'green'}
                fontSize="xs"
              >
                {gmbItem.isDraft ? 'Draft' : 'Publie'}
              </Badge>
            </Flex>
            <PublishButton item={gmbItem} />
          </Flex>

          {/* Posts table */}
          {posts.length > 0 ? (
            <Box overflowX="auto">
              <Table.Root size="sm">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeader w="40px">#</Table.ColumnHeader>
                    <Table.ColumnHeader w="100px">Date</Table.ColumnHeader>
                    <Table.ColumnHeader w="80px">Type</Table.ColumnHeader>
                    <Table.ColumnHeader>Contenu</Table.ColumnHeader>
                    <Table.ColumnHeader w="100px">CTA</Table.ColumnHeader>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {posts.map((post, idx) => (
                    <Table.Row
                      key={idx}
                      cursor="pointer"
                      _hover={{ bg: 'gray.50' }}
                      onClick={() => handlePostClick(gmbItem, post, idx)}
                    >
                      <Table.Cell fontSize="xs" color="gray.500">
                        {idx + 1}
                      </Table.Cell>
                      <Table.Cell fontSize="xs" color="gray.600">
                        {post.scheduled_at
                          ? post.scheduled_at.split('T')[0]
                          : '\u2014'}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge colorPalette="red" fontSize="10px">
                          {post.type || 'POST'}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell fontSize="xs" maxW="400px">
                        <Text lineClamp={2}>{post.content || '\u2014'}</Text>
                      </Table.Cell>
                      <Table.Cell fontSize="xs" color="gray.500">
                        {post.cta?.action || '\u2014'}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Box>
          ) : (
            <Text fontSize="sm" color="gray.400">
              Aucun post dans ce fichier.
            </Text>
          )}
        </Box>
      ))}
    </Box>
  )
}
