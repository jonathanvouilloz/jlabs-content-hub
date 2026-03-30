import {
  DrawerRoot,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerCloseTrigger,
  DrawerBackdrop,
  Box,
  Text,
  Flex,
  Separator,
  Badge,
  VStack,
} from '@chakra-ui/react'
import { useHub } from '../context/HubContext'
import { renderMarkdown } from '../utils/markdown'
import TypeBadge from './TypeBadge'
import PublishButton from './PublishButton'
import ProjectBadge from './ProjectBadge'

const markdownStyles = {
  '& h1': { fontSize: '2xl', fontWeight: 'bold', mt: 6, mb: 3 },
  '& h2': { fontSize: 'xl', fontWeight: 'bold', mt: 5, mb: 2 },
  '& h3': { fontSize: 'lg', fontWeight: 'semibold', mt: 4, mb: 2 },
  '& p': { mb: 3, lineHeight: 1.7 },
  '& ul': { pl: 6, mb: 3 },
  '& ol': { pl: 6, mb: 3 },
  '& li': { mb: 1 },
  '& code': { bg: 'gray.100', px: 1.5, py: 0.5, borderRadius: 'md', fontSize: 'sm', fontFamily: 'mono' },
  '& pre': { bg: 'gray.100', p: 4, borderRadius: 'md', overflowX: 'auto', mb: 3, '& code': { bg: 'transparent', p: 0 } },
  '& blockquote': { borderLeft: '3px solid', borderColor: 'gray.300', pl: 4, py: 1, my: 3, color: 'gray.600', fontStyle: 'italic' },
  '& a': { color: 'blue.500', textDecoration: 'underline' },
  '& table': { width: '100%', mb: 3, borderCollapse: 'collapse', '& th, & td': { border: '1px solid', borderColor: 'gray.200', px: 3, py: 2, fontSize: 'sm' }, '& th': { bg: 'gray.50', fontWeight: 'semibold' } },
  '& img': { maxWidth: '100%', borderRadius: 'md', my: 3 },
}

export default function ContentDrawer() {
  const { selectedItem, setSelectedItem } = useHub()

  const isOpen = selectedItem !== null
  const item = selectedItem

  const handleClose = () => setSelectedItem(null)

  if (!item) return null

  // Determine display type and data
  const isGmbPost = item.type === 'gmb-post'
  const isGmb = item.type === 'gmb'
  const isArticle = item.type === 'article'
  const isLinkedin = item.type === 'linkedin'

  const title = isGmbPost
    ? (item.gmbPost?.title || item.frontmatter?.title || 'Post GMB')
    : (item.frontmatter?.title || item.slug || 'Sans titre')

  const displayType = isGmbPost ? 'gmb' : (item.type || item.contentType || 'article')

  return (
    <DrawerRoot open={isOpen} onOpenChange={() => handleClose()} placement="end" size="lg">
      <DrawerBackdrop />
      <DrawerContent>
        <DrawerCloseTrigger />

        <DrawerHeader pb={2}>
          <Text fontSize="lg" fontWeight="bold" pr={8} mb={2}>
            {title}
          </Text>
          <Flex gap={2} align="center" flexWrap="wrap">
            <TypeBadge type={displayType} />
            <ProjectBadge project={item.project} />
            {!isGmbPost && <PublishButton item={item} />}
          </Flex>
        </DrawerHeader>

        <Separator />

        <DrawerBody pt={4}>
          {/* Single GMB post detail (from GmbView row click) */}
          {isGmbPost && item.gmbPost && (
            <VStack align="stretch" gap={4}>
              <GmbPostDetail post={item.gmbPost} />
            </VStack>
          )}

          {/* GMB file: show all posts */}
          {isGmb && item.gmbData && (
            <VStack align="stretch" gap={4}>
              {item.gmbData.map((post, idx) => (
                <GmbPostDetail key={idx} post={post} index={idx} />
              ))}
              {item.gmbData.length === 0 && (
                <Text fontSize="sm" color="gray.400">Aucun post dans ce fichier.</Text>
              )}
            </VStack>
          )}

          {/* Article: render markdown */}
          {isArticle && (
            <Box
              className="markdown-content"
              css={markdownStyles}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.frontmatter?.body || '') }}
            />
          )}

          {/* LinkedIn: day badge + article link + markdown */}
          {isLinkedin && (
            <>
              <Flex gap={2} mb={4} flexWrap="wrap">
                {item.frontmatter?.day && (
                  <Badge colorPalette="orange" fontSize="xs">{item.frontmatter.day}</Badge>
                )}
                {item.frontmatter?.article_slug && (
                  <Text fontSize="sm" color="gray.500">
                    Article: <Text as="span" color="blue.500" fontWeight="medium">{item.frontmatter.article_slug}</Text>
                  </Text>
                )}
              </Flex>
              <Box
                className="markdown-content"
                css={markdownStyles}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(item.frontmatter?.body || '') }}
              />
            </>
          )}
        </DrawerBody>
      </DrawerContent>
    </DrawerRoot>
  )
}

function GmbPostDetail({ post, index }) {
  return (
    <Box p={4} border="1px solid" borderColor="gray.200" borderRadius="md">
      <Flex justify="space-between" mb={2}>
        <Badge colorPalette="red" fontSize="xs">{post.type || 'POST'}</Badge>
        {post.scheduled_at && (
          <Text fontSize="xs" color="gray.500">{post.scheduled_at.split('T')[0]} {post.scheduled_at.split('T')[1]?.substring(0, 5) || ''}</Text>
        )}
      </Flex>
      {post.title && <Text fontSize="sm" fontWeight="600" mb={1}>{post.title}</Text>}
      <Text fontSize="sm" mb={2} whiteSpace="pre-wrap">{post.content || ''}</Text>
      {post.cta && (
        <Text fontSize="xs" color="blue.500" mb={1}>
          {post.cta.action || ''} {post.cta.url ? `→ ${post.cta.url}` : ''}
        </Text>
      )}
      {post.image_text && (
        <Text fontSize="xs" color="gray.500" mt={2}><strong>Image:</strong> {post.image_text}</Text>
      )}
      {(post.image_prompt || post.image?.prompt) && (
        <Text fontSize="xs" color="gray.400" fontStyle="italic" mt={1}>
          <strong>Prompt:</strong> {post.image_prompt || post.image?.prompt}
        </Text>
      )}
    </Box>
  )
}
