import React from 'react'
import { Text } from 'react-native'
import glyphs from '../assets/material-icons.json'
export function MaterialDesignIcons({ name, size = 24, color, ...props }: any) {
  return (
    <Text
      {...props}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ fontFamily: 'MaterialDesignIcons', fontSize: size, color }}
    >
      {String.fromCodePoint(
        (glyphs as Record<string, number>)[name] ?? glyphs['help-circle-outline'],
      )}
    </Text>
  )
}

export default MaterialDesignIcons
