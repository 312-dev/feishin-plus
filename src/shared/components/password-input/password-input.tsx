import {
    PasswordInput as MantinePasswordInput,
    PasswordInputProps as MantinePasswordInputProps,
} from '@mantine/core';
import { CSSProperties, forwardRef } from 'react';

import styles from './password-input.module.css';

export interface PasswordInputProps extends MantinePasswordInputProps {
    maxWidth?: CSSProperties['maxWidth'];
    width?: CSSProperties['width'];
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
    ({ children, classNames, maxWidth, style, variant = 'default', width, ...props }, ref) => {
        return (
            <MantinePasswordInput
                classNames={{
                    description: styles.description,
                    // Mantine's PasswordInput puts the real <input> under `innerInput`, not
                    // `input` (that name is TextInput's, which has no separate wrapper) - so
                    // `input` here targets nothing and the visible field was left unstyled,
                    // rendering with no background/border against a dark theme.
                    innerInput: styles.input,
                    label: styles.label,
                    required: styles.required,
                    root: styles.root,
                    section: styles.section,
                    ...classNames,
                }}
                ref={ref}
                style={{ maxWidth, width, ...style }}
                variant={variant}
                {...props}
            >
                {children}
            </MantinePasswordInput>
        );
    },
);
