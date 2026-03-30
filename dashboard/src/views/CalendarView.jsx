import { Box, Flex, Text, IconButton, SimpleGrid, VStack, HStack, Badge } from '@chakra-ui/react'
import { useState } from 'react'
import { useHub } from '../context/HubContext'
import TypeBadge from '../components/TypeBadge'
import ProjectBadge from '../components/ProjectBadge'

const MONTHS = [
  'Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre',
]
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']

const DOT_COLORS = {
  article: 'blue.400',
  gmb: 'red.400',
  linkedin: '#0a66c2',
}

export default function CalendarView() {
  const { articles, activeProject, setSelectedItem } = useHub()

  const today = new Date()
  const [currentYear, setCurrentYear] = useState(today.getFullYear())
  const [currentMonth, setCurrentMonth] = useState(today.getMonth())
  const [selectedDay, setSelectedDay] = useState(null)

  const isPipeline = activeProject === '__pipeline'

  // Filter items by project
  let items = isPipeline
    ? articles
    : articles.filter((a) => a.project === activeProject)

  // Build dateMap: { 'YYYY-MM-DD': [{ item, label }] }
  const dateMap = {}

  const addToDate = (dateStr, entry) => {
    if (!dateStr) return
    // Normalize to YYYY-MM-DD
    const key = dateStr.split('T')[0]
    if (!key || key.length < 10) return
    if (!dateMap[key]) dateMap[key] = []
    dateMap[key].push(entry)
  }

  items.forEach((item) => {
    if (item.type === 'article' || item.type === 'linkedin') {
      const date = item.frontmatter?.date || item.date
      addToDate(date, { item, type: item.type })
    } else if (item.type === 'gmb' && item.posts) {
      item.posts.forEach((post) => {
        addToDate(post.scheduled_at, {
          item,
          type: 'gmb',
          gmbPost: post,
        })
      })
    }
  })

  // Calendar math
  const firstDay = new Date(currentYear, currentMonth, 1)
  const startDow = (firstDay.getDay() + 6) % 7 // Monday=0
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate()

  const prevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11)
      setCurrentYear(currentYear - 1)
    } else {
      setCurrentMonth(currentMonth - 1)
    }
    setSelectedDay(null)
  }

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0)
      setCurrentYear(currentYear + 1)
    } else {
      setCurrentMonth(currentMonth + 1)
    }
    setSelectedDay(null)
  }

  // Build cells array
  const cells = []
  for (let i = 0; i < startDow; i++) {
    cells.push({ day: null, key: `empty-${i}` })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({ day: d, dateStr, key: dateStr })
  }

  const selectedEntries = selectedDay ? dateMap[selectedDay] || [] : []

  const handleEntryClick = (entry) => {
    if (entry.gmbPost) {
      setSelectedItem({
        type: 'gmb-post',
        project: entry.item.project,
        title: entry.gmbPost.title || 'GMB Post',
        frontmatter: {
          title: entry.gmbPost.title || 'GMB Post',
          date: entry.gmbPost.scheduled_at?.split('T')[0],
        },
        isDraft: entry.item.isDraft,
        gmbPost: entry.gmbPost,
        parentItem: entry.item,
      })
    } else {
      setSelectedItem(entry.item)
    }
  }

  return (
    <Box>
      {/* Navigation */}
      <Flex align="center" justify="center" gap={4} mb={4}>
        <IconButton
          aria-label="Mois precedent"
          variant="ghost"
          size="sm"
          onClick={prevMonth}
        >
          <Text fontSize="lg">&lsaquo;</Text>
        </IconButton>
        <Text fontWeight="bold" fontSize="md" minW="160px" textAlign="center">
          {MONTHS[currentMonth]} {currentYear}
        </Text>
        <IconButton
          aria-label="Mois suivant"
          variant="ghost"
          size="sm"
          onClick={nextMonth}
        >
          <Text fontSize="lg">&rsaquo;</Text>
        </IconButton>
      </Flex>

      {/* Day headers */}
      <SimpleGrid columns={7} mb={1}>
        {DAYS.map((d) => (
          <Text
            key={d}
            textAlign="center"
            fontSize="xs"
            fontWeight="semibold"
            color="gray.500"
            py={1}
          >
            {d}
          </Text>
        ))}
      </SimpleGrid>

      {/* Calendar grid */}
      <SimpleGrid columns={7} gap={1}>
        {cells.map((cell) => {
          if (!cell.day) {
            return <Box key={cell.key} minH="60px" />
          }

          const entries = dateMap[cell.dateStr] || []
          const isSelected = selectedDay === cell.dateStr
          const isToday =
            cell.day === today.getDate() &&
            currentMonth === today.getMonth() &&
            currentYear === today.getFullYear()

          return (
            <Box
              key={cell.key}
              minH="60px"
              p={1}
              border="1px solid"
              borderColor={isSelected ? 'brand.400' : 'gray.100'}
              borderRadius="md"
              bg={isSelected ? 'brand.50' : isToday ? 'gray.50' : 'white'}
              cursor={entries.length > 0 ? 'pointer' : 'default'}
              _hover={entries.length > 0 ? { borderColor: 'brand.300' } : {}}
              onClick={() => entries.length > 0 && setSelectedDay(cell.dateStr)}
            >
              <Text
                fontSize="xs"
                fontWeight={isToday ? 'bold' : 'normal'}
                color={isToday ? 'brand.600' : 'gray.600'}
                mb={0.5}
              >
                {cell.day}
              </Text>
              <Flex gap={0.5} flexWrap="wrap">
                {entries.map((entry, idx) => (
                  <Box
                    key={idx}
                    w="8px"
                    h="8px"
                    borderRadius="full"
                    bg={DOT_COLORS[entry.type] || 'gray.400'}
                    opacity={entry.item.isDraft ? 0.6 : 1}
                    border={!entry.item.isDraft ? '1.5px solid' : 'none'}
                    borderColor="green.400"
                  />
                ))}
              </Flex>
            </Box>
          )
        })}
      </SimpleGrid>

      {/* Selected day detail */}
      {selectedDay && (
        <Box mt={4} pt={4} borderTop="1px solid" borderColor="gray.200">
          <Text fontWeight="semibold" fontSize="sm" mb={3} color="gray.700">
            {selectedDay}
          </Text>
          {selectedEntries.length === 0 ? (
            <Text fontSize="sm" color="gray.400">
              Aucun contenu ce jour.
            </Text>
          ) : (
            <VStack align="stretch" gap={2}>
              {selectedEntries.map((entry, idx) => (
                <Box
                  key={idx}
                  p={2}
                  border="1px solid"
                  borderColor="gray.200"
                  borderRadius="md"
                  cursor="pointer"
                  _hover={{ borderColor: 'brand.400' }}
                  onClick={() => handleEntryClick(entry)}
                >
                  <Flex align="center" gap={2}>
                    <TypeBadge type={entry.type} />
                    {isPipeline && <ProjectBadge project={entry.item.project} />}
                    <Text fontSize="sm" fontWeight="medium" lineClamp={1}>
                      {entry.gmbPost
                        ? entry.gmbPost.content?.slice(0, 60) || 'GMB Post'
                        : entry.item.title}
                    </Text>
                    <Badge
                      ml="auto"
                      colorPalette={entry.item.isDraft ? 'orange' : 'green'}
                      fontSize="10px"
                    >
                      {entry.item.isDraft ? 'Draft' : 'Publie'}
                    </Badge>
                  </Flex>
                </Box>
              ))}
            </VStack>
          )}
        </Box>
      )}
    </Box>
  )
}
