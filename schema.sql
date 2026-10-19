-- Quidey database schema (structure only, no data)
--
-- Generated from the development database with:
--   pg_dump --schema-only --no-owner --no-privileges --no-comments
-- Cleaned up so it also runs outside psql and on PostgreSQL versions before 17.
--
-- Set up a fresh database (e.g. on the server):
--   createdb quidey
--   psql -d quidey -f schema.sql
--
-- After changing tables, regenerate this file the same way so it stays the source of truth.

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_actions (
    id integer NOT NULL,
    admin_id integer,
    admin_username text NOT NULL,
    target_id integer,
    target_username text NOT NULL,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_actions_action_check CHECK ((action = ANY (ARRAY['grant_pro'::text, 'revoke_pro'::text, 'grant_admin'::text, 'revoke_admin'::text, 'approve_request'::text, 'decline_request'::text, 'reset_request'::text])))
);

--
-- Name: admin_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: admin_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_actions_id_seq OWNED BY public.admin_actions.id;

--
-- Name: beta_access_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beta_access_requests (
    user_id integer NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT beta_access_requests_reason_check CHECK (((length(reason) >= 10) AND (length(reason) <= 1000))),
    CONSTRAINT beta_access_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text])))
);

--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    id integer NOT NULL,
    requester_id integer NOT NULL,
    addressee_id integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    CONSTRAINT friendships_check CHECK ((requester_id <> addressee_id)),
    CONSTRAINT friendships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text])))
);

--
-- Name: friendships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.friendships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: friendships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.friendships_id_seq OWNED BY public.friendships.id;

--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    user_id integer
);

--
-- Name: groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.groups_id_seq OWNED BY public.groups.id;

--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id integer NOT NULL,
    task_id integer,
    content text,
    created_at timestamp without time zone DEFAULT now()
);

--
-- Name: notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notes_id_seq OWNED BY public.notes.id;

--
-- Name: session_shared_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_shared_tasks (
    session_id integer NOT NULL,
    shared_task_id integer NOT NULL,
    time_ms integer DEFAULT 0 NOT NULL,
    CONSTRAINT session_shared_tasks_time_ms_check CHECK ((time_ms >= 0))
);

--
-- Name: session_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_tasks (
    session_id integer NOT NULL,
    task_id integer NOT NULL,
    time_ms integer DEFAULT 0 NOT NULL
);

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id integer NOT NULL,
    group_id integer,
    time_ms integer,
    date timestamp without time zone DEFAULT now(),
    user_id integer
);

--
-- Name: sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;

--
-- Name: shared_session_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_events (
    id integer NOT NULL,
    session_id integer NOT NULL,
    user_id integer,
    type text NOT NULL,
    task_id integer,
    task_name text,
    text text,
    target_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_session_events_text_check CHECK ((length(text) <= 1000)),
    CONSTRAINT shared_session_events_type_check CHECK ((type = ANY (ARRAY['created'::text, 'joined'::text, 'left'::text, 'removed'::text, 'task_added'::text, 'task_done'::text, 'task_reopened'::text, 'task_assigned'::text, 'started'::text, 'message'::text, 'renamed'::text, 'ended'::text])))
);

--
-- Name: shared_session_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_session_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_session_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_session_events_id_seq OWNED BY public.shared_session_events.id;

--
-- Name: shared_session_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_members (
    session_id integer NOT NULL,
    user_id integer NOT NULL,
    status text DEFAULT 'invited'::text NOT NULL,
    invited_by integer,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone,
    current_task_id integer,
    last_seen_at timestamp with time zone,
    CONSTRAINT shared_session_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'joined'::text])))
);

--
-- Name: shared_session_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_tasks (
    id integer NOT NULL,
    session_id integer NOT NULL,
    name text NOT NULL,
    description text,
    done boolean DEFAULT false NOT NULL,
    added_by integer,
    source_task_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assignee_id integer,
    CONSTRAINT shared_session_tasks_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200)))
);

--
-- Name: shared_session_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_session_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_session_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_session_tasks_id_seq OWNED BY public.shared_session_tasks.id;

--
-- Name: shared_session_time; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_time (
    task_id integer NOT NULL,
    user_id integer NOT NULL,
    time_ms bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_session_time_time_ms_check CHECK ((time_ms >= 0))
);

--
-- Name: shared_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_sessions (
    id integer NOT NULL,
    name text NOT NULL,
    owner_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT shared_sessions_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100)))
);

--
-- Name: shared_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_sessions_id_seq OWNED BY public.shared_sessions.id;

--
-- Name: task_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_groups (
    task_id integer NOT NULL,
    group_id integer NOT NULL
);

--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id integer NOT NULL,
    name text NOT NULL,
    due date,
    description text,
    prio integer,
    done boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    user_id integer
);

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    display_name text,
    birth_date date,
    email text,
    is_pro boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    token_version integer DEFAULT 0 NOT NULL
);

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

--
-- Name: admin_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions ALTER COLUMN id SET DEFAULT nextval('public.admin_actions_id_seq'::regclass);

--
-- Name: friendships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships ALTER COLUMN id SET DEFAULT nextval('public.friendships_id_seq'::regclass);

--
-- Name: groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups ALTER COLUMN id SET DEFAULT nextval('public.groups_id_seq'::regclass);

--
-- Name: notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes ALTER COLUMN id SET DEFAULT nextval('public.notes_id_seq'::regclass);

--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);

--
-- Name: shared_session_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events ALTER COLUMN id SET DEFAULT nextval('public.shared_session_events_id_seq'::regclass);

--
-- Name: shared_session_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks ALTER COLUMN id SET DEFAULT nextval('public.shared_session_tasks_id_seq'::regclass);

--
-- Name: shared_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_sessions ALTER COLUMN id SET DEFAULT nextval('public.shared_sessions_id_seq'::regclass);

--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);

--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

--
-- Name: admin_actions admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (id);

--
-- Name: beta_access_requests beta_access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta_access_requests
    ADD CONSTRAINT beta_access_requests_pkey PRIMARY KEY (user_id);

--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (id);

--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);

--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);

--
-- Name: session_shared_tasks session_shared_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_shared_tasks
    ADD CONSTRAINT session_shared_tasks_pkey PRIMARY KEY (session_id, shared_task_id);

--
-- Name: session_tasks session_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_tasks
    ADD CONSTRAINT session_tasks_pkey PRIMARY KEY (session_id, task_id);

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

--
-- Name: shared_session_events shared_session_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_pkey PRIMARY KEY (id);

--
-- Name: shared_session_members shared_session_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_pkey PRIMARY KEY (session_id, user_id);

--
-- Name: shared_session_tasks shared_session_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_pkey PRIMARY KEY (id);

--
-- Name: shared_session_time shared_session_time_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_time
    ADD CONSTRAINT shared_session_time_pkey PRIMARY KEY (task_id, user_id);

--
-- Name: shared_sessions shared_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_sessions
    ADD CONSTRAINT shared_sessions_pkey PRIMARY KEY (id);

--
-- Name: task_groups task_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_pkey PRIMARY KEY (task_id, group_id);

--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);

--
-- Name: admin_actions_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_actions_created_idx ON public.admin_actions USING btree (created_at DESC);

--
-- Name: beta_access_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX beta_access_requests_status_idx ON public.beta_access_requests USING btree (status, created_at);

--
-- Name: friendships_addressee_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_addressee_status_idx ON public.friendships USING btree (addressee_id, status);

--
-- Name: friendships_pair_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX friendships_pair_unique ON public.friendships USING btree (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

--
-- Name: friendships_requester_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_requester_status_idx ON public.friendships USING btree (requester_id, status);

--
-- Name: shared_session_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_events_session_idx ON public.shared_session_events USING btree (session_id, id);

--
-- Name: shared_session_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_members_user_idx ON public.shared_session_members USING btree (user_id, status);

--
-- Name: shared_session_tasks_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_tasks_session_idx ON public.shared_session_tasks USING btree (session_id);

--
-- Name: shared_session_tasks_source_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shared_session_tasks_source_unique ON public.shared_session_tasks USING btree (session_id, source_task_id) WHERE (source_task_id IS NOT NULL);

--
-- Name: users_email_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_unique ON public.users USING btree (lower(email));

--
-- Name: users_username_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_lower_unique ON public.users USING btree (lower(username));

--
-- Name: admin_actions admin_actions_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: admin_actions admin_actions_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: beta_access_requests beta_access_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta_access_requests
    ADD CONSTRAINT beta_access_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: friendships friendships_addressee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_addressee_id_fkey FOREIGN KEY (addressee_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: friendships friendships_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: groups groups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- Name: notes notes_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: session_shared_tasks session_shared_tasks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_shared_tasks
    ADD CONSTRAINT session_shared_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

--
-- Name: session_shared_tasks session_shared_tasks_shared_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_shared_tasks
    ADD CONSTRAINT session_shared_tasks_shared_task_id_fkey FOREIGN KEY (shared_task_id) REFERENCES public.shared_session_tasks(id) ON DELETE CASCADE;

--
-- Name: session_tasks session_tasks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_tasks
    ADD CONSTRAINT session_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

--
-- Name: session_tasks session_tasks_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_tasks
    ADD CONSTRAINT session_tasks_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: sessions sessions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id);

--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- Name: shared_session_events shared_session_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

--
-- Name: shared_session_events shared_session_events_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_events shared_session_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.shared_session_tasks(id) ON DELETE SET NULL;

--
-- Name: shared_session_events shared_session_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_members shared_session_members_current_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_current_task_id_fkey FOREIGN KEY (current_task_id) REFERENCES public.shared_session_tasks(id) ON DELETE SET NULL;

--
-- Name: shared_session_members shared_session_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_members shared_session_members_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

--
-- Name: shared_session_members shared_session_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: shared_session_tasks shared_session_tasks_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_tasks shared_session_tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_tasks shared_session_tasks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

--
-- Name: shared_session_tasks shared_session_tasks_source_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_source_task_id_fkey FOREIGN KEY (source_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;

--
-- Name: shared_session_time shared_session_time_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_time
    ADD CONSTRAINT shared_session_time_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.shared_session_tasks(id) ON DELETE CASCADE;

--
-- Name: shared_session_time shared_session_time_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_time
    ADD CONSTRAINT shared_session_time_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: shared_sessions shared_sessions_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_sessions
    ADD CONSTRAINT shared_sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: task_groups task_groups_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;

--
-- Name: task_groups task_groups_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: tasks tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- PostgreSQL database dump complete
--

