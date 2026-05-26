//! Conversation state for the companion app.
//!
//! Stores the system prompt, turn history, and renders it into the
//! prompt format the active LLM expects. Trims oldest turns when the
//! context window overflows so the conversation can run indefinitely
//! without blowing past the model's `n_ctx`.
//!
//! Pure data structure — no LLM calls or threading. Used by the
//! orchestrator: append a turn, render, hand to `Summarizer::stream_completion`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub struct Turn {
    pub role: Role,
    pub content: String,
}

pub struct Conversation {
    pub system: String,
    pub turns: Vec<Turn>,
    /// Soft cap on the prompt token count — when `render` produces
    /// something larger than this (estimated as chars/4), the oldest
    /// non-system turns are dropped until it fits. Roughly half the
    /// model's `n_ctx` so there's room for the model's reply.
    pub max_prompt_chars: usize,
}

impl Conversation {
    pub fn new(system_prompt: impl Into<String>) -> Self {
        Self {
            system: system_prompt.into(),
            turns: Vec::new(),
            // 4 chars per token is a conservative estimate; for n_ctx=2048
            // this leaves ~half (~1024 tokens) for the model's reply.
            max_prompt_chars: 4096,
        }
    }

    pub fn user(&mut self, text: impl Into<String>) {
        self.turns.push(Turn { role: Role::User, content: text.into() });
        self.trim_to_fit();
    }

    pub fn assistant(&mut self, text: impl Into<String>) {
        self.turns.push(Turn { role: Role::Assistant, content: text.into() });
        self.trim_to_fit();
    }

    pub fn clear_turns(&mut self) {
        self.turns.clear();
    }

    /// Render the conversation as a ChatML-style prompt — works for
    /// SmolLM2, Qwen, Phi-3, and most modern instruct-tuned models. If
    /// you swap in a model that wants Llama-3 or Mistral templates,
    /// fork this method.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("<|im_start|>system\n");
        out.push_str(&self.system);
        out.push_str("<|im_end|>\n");
        for t in &self.turns {
            let role = match t.role {
                Role::User => "user",
                Role::Assistant => "assistant",
                Role::System => continue, // additional system turns ignored
            };
            out.push_str("<|im_start|>");
            out.push_str(role);
            out.push('\n');
            out.push_str(&t.content);
            out.push_str("<|im_end|>\n");
        }
        // Open the assistant turn — the model fills in from here.
        out.push_str("<|im_start|>assistant\n");
        out
    }

    fn trim_to_fit(&mut self) {
        // Cheap approximate: drop the oldest user/assistant pair until
        // the rendered prompt fits in max_prompt_chars. Always keep the
        // most recent turn even if oversized (caller's problem then).
        while self.render().len() > self.max_prompt_chars && self.turns.len() > 1 {
            // Drop the oldest two turns (one user + its reply) to keep
            // the conversation pairs balanced.
            self.turns.drain(..self.turns.len().min(2));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_chatml() {
        let mut c = Conversation::new("you are helpful");
        c.user("hi");
        c.assistant("hello!");
        let rendered = c.render();
        assert!(rendered.starts_with("<|im_start|>system\nyou are helpful<|im_end|>"));
        assert!(rendered.contains("<|im_start|>user\nhi<|im_end|>"));
        assert!(rendered.contains("<|im_start|>assistant\nhello!<|im_end|>"));
        assert!(rendered.ends_with("<|im_start|>assistant\n"));
    }

    #[test]
    fn trims_when_overflowing() {
        let mut c = Conversation::new("sys");
        c.max_prompt_chars = 200;
        for i in 0..20 {
            c.user(format!("user turn {} with some text", i));
            c.assistant(format!("assistant turn {} with some text", i));
        }
        assert!(c.render().len() <= 400); // some slack for header
        assert!(c.turns.len() < 40);
    }
}
