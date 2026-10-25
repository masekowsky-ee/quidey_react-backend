-- 027: what testers think of the features they test (the Tester page in the app).
-- Already part of schema.sql. Run this only on a database created before it.
--
--   tester_feedback   one row per tester and topic: stars (1-5) and/or a comment, changed as
--                     often as they like. A topic names what is tested: 'ui:<variant>' for the
--                     interface variants, 'feature:<name>' for a feature. Gone with the account.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS tester_feedback (
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic text NOT NULL,
    rating smallint,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, topic),
    CONSTRAINT tester_feedback_topic_check CHECK (topic ~ '^[a-z0-9]+:[a-z0-9-]{1,48}$'),
    CONSTRAINT tester_feedback_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    CONSTRAINT tester_feedback_comment_check CHECK (comment IS NULL OR char_length(comment) <= 2000),
    CONSTRAINT tester_feedback_something_check CHECK (rating IS NOT NULL OR comment IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS tester_feedback_topic_idx ON tester_feedback (topic);
